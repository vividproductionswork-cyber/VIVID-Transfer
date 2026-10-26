/**
 * Vivid Transfer v2: large-file sharing on Google Drive, WeTransfer-style.
 *
 * Two deployments of this same script:
 *  - PUBLIC  (Who has access: Anyone, even anonymous): what clients open from a link.
 *            Visitors identify themselves by typing a name and an invited email.
 *  - OWNER   (Who has access: Only myself): the sending and dashboard screens.
 *            Google sign-in identifies the owner.
 *
 * Every download goes through a gate URL that logs the event and notifies the
 * owner, the uploader and the downloader before sending them on to the file.
 * Transfers and their files are permanently deleted after EXPIRY_DAYS.
 */

const CONFIG = {
  EXPIRY_DAYS: 15,
  WARN_DAYS_BEFORE: 2,
  MAX_TRANSFER_BYTES: 50 * 1024 * 1024 * 1024, // 50 GB per transfer
  CHUNK_SIZE: 16 * 1024 * 1024,                // multiple of 256 KiB, as Drive requires
  UPLOAD_RESERVATION_HOURS: 48,                // space held for an upload that never finishes
  BRAND: 'Vivid Productions',
  TZ: 'Asia/Kolkata',
  ROOT_FOLDER_NAME: 'Vivid Transfers',
  REGISTRY_NAME: 'Vivid Transfers Registry'
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SHEETS = {
  Transfers: ['id', 'title', 'folderId', 'recipients', 'createdAt', 'expiresAt', 'status', 'warnSentAt', 'deletedAt'],
  Downloads: ['eventId', 'transferId', 'fileId', 'fileName', 'downloaderName', 'downloaderEmail', 'at'],
  Uploads: ['sessionId', 'transferId', 'uploaderName', 'uploaderEmail', 'fileName', 'size', 'createdAt', 'status', 'fileId'],
  Notifications: ['key', 'to', 'sentAt', 'error']
};

// ===========================================================================
// Web app entry points
// ===========================================================================

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.api === '1') return apiResponse_(p);

  // Download gate: logs the download, notifies, then sends the person to the file.
  if (p.go === '1' && p.f) {
    return handleDownload_(p.t || '', p.f, p.k || '');
  }

  const tmpl = HtmlService.createTemplateFromFile('Index');
  tmpl.transferId = p.t ? String(p.t) : '';
  return tmpl.evaluate()
    .setTitle(CONFIG.BRAND + ' Transfer')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ===========================================================================
// Functions called from the page via google.script.run
// ===========================================================================

/** Who is looking at this page, and (owner only) the dashboard data. */
function getPageState() {
  const owner = ownerKeyOk_();
  return {
    isOwner: owner,
    ownerEmail: owner ? ownerEmail_() : '',
    publicUrl: publicUrlOrEmpty_(),
    transfers: owner ? listForOwner_() : []
  };
}


/**
 * A recipient (or the owner) opens a transfer by typing their name and an
 * invited email. The same message is used for "no such transfer" and
 * "not invited", so transfer ids can't be probed.
 */
function getTransferView(transferId, name, email) {
  resolveAccess_(transferId);
  const t = getTransfer_(transferId);
  if (!t) throw new Error(NOT_INVITED_);
  return detail_(t);
}


/** Owner only: create a transfer and email the recipients. */
function createTransfer(title, recipientsText, note) {
  requireOwner_();
  const publicUrl = publicUrl_();
  const recipients = parseEmails_(recipientsText);
  if (!recipients.length) throw new Error('Add at least one recipient email.');

  const cleanTitle = clean_(title, 120) || 'Untitled transfer';
  const now = new Date();
  const expires = new Date(now.getTime() + CONFIG.EXPIRY_DAYS * DAY_MS);
  const id = Utilities.getUuid();

  const folder = getRootFolder_().createFolder(cleanTitle + ' (' + fmtDate_(now) + ')');
  // Anyone with the link can see the folder's files. Files are only reachable
  // through the gate, which checks that the email is on the invited list.
  folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  appendRow_('Transfers', {
    id: id, title: cleanTitle, folderId: folder.getId(), recipients: recipients.join(','),
    createdAt: now.toISOString(), expiresAt: expires.toISOString(), status: 'active',
    warnSentAt: '', deletedAt: ''
  });

  const t = { id: id, title: cleanTitle, expiresAt: expires, recipients: recipients };
  recipients.forEach(function (r) {
    sendOnce_('invite:' + id + ':' + r, r, 'Files ready: ' + cleanTitle,
      mail_('Your files are ready.', [
        'Hello,',
        'Open the link below to upload or download the files for ' + cleanTitle + '.',
        clean_(note, 1000)
      ], t, transferUrl_(id), 'Open transfer'));
  });

  return { id: id, url: transferUrl_(id), expiresAt: expires.toISOString() };
}

/** Owner only: change who is on the invited list. New addresses are emailed. */
function updateRecipients(transferId, recipientsText) {
  requireOwner_();
  const t = mustGetTransfer_(transferId);
  if (!isActive_(t)) throw new Error('This transfer has been deleted, so its recipients cannot change.');
  const recipients = parseEmails_(recipientsText);
  if (!recipients.length) throw new Error('Add at least one recipient email.');
  setField_('Transfers', t.row, 'recipients', recipients.join(','));
  const added = recipients.filter(function (r) { return t.recipients.indexOf(r) === -1; });
  added.forEach(function (r) {
    sendOnce_('invite:' + t.id + ':' + r, r, 'Files ready: ' + t.title,
      mail_('Your files are ready.', ['Hello,', 'You have been added to ' + t.title + '.'],
        t, transferUrl_(t.id), 'Open transfer'));
  });
  return { recipients: recipients };
}


/** Owner only: delete a transfer now instead of waiting for expiry. */
function deleteTransferNow(transferId) {
  requireOwner_();
  const t = mustGetTransfer_(transferId);
  if (t.status !== 'active') throw new Error('This transfer is already deleted.');
  finishDeletion_(t);
  return { ok: true };
}

/**
 * Start a resumable Drive upload into the transfer folder. The browser then
 * PUTs the file in chunks to the returned URL.
 */
function createUploadSession(transferId, name, email, fileName, fileSize, mimeType) {
  const a = resolveAccess_(transferId);
  const t = getTransfer_(transferId);
  if (!t) throw new Error(NOT_INVITED_);
  if (!isActive_(t)) throw new Error('This transfer has expired and been deleted.');

  const size = Number(fileSize);
  if (!size || size <= 0) throw new Error('Could not read the file size.');
  const fname = clean_(fileName, 200) || 'upload';
  const type = mimeType || 'application/octet-stream';
  const uploaderName = a.owner ? (clean_(name, 80) || 'Owner') : a.name;
  const uploaderEmail = a.owner ? ownerEmail_() : a.email;

  // Check the limit and reserve the space under a lock, so two uploads can't both pass.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let sid;
  try {
    const used = folderBytes_(t.folderId) + reservedBytes_(t.id);
    if (used + size > CONFIG.MAX_TRANSFER_BYTES) {
      throw new Error('This file would take the transfer over 50 GB. Create a new transfer for the rest.');
    }
    sid = Utilities.getUuid();
    appendRow_('Uploads', {
      sessionId: sid, transferId: t.id, uploaderName: uploaderName, uploaderEmail: uploaderEmail,
      fileName: fname, size: size, createdAt: new Date().toISOString(), status: 'open', fileId: ''
    });
  } finally {
    lock.releaseLock();
  }

  const res = UrlFetchApp.fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
        'X-Upload-Content-Type': type,
        'X-Upload-Content-Length': String(size)
      },
      payload: JSON.stringify({ name: fname, parents: [t.folderId], mimeType: type }),
      muteHttpExceptions: true
    }
  );
  if (res.getResponseCode() !== 200) {
    setUploadStatus_(sid, 'failed');
    throw new Error('Could not start the upload (Drive returned ' + res.getResponseCode() + ').');
  }
  const headers = res.getHeaders();
  const location = headers.Location || headers.location;
  if (!location) {
    setUploadStatus_(sid, 'failed');
    throw new Error('Drive did not return an upload address.');
  }
  return { sessionId: sid, uploadUrl: location, chunkSize: CONFIG.CHUNK_SIZE };
}


/** Called by the browser once Drive has stored the whole file. */
function confirmUpload(transferId, sessionId, fileId) {
  resolveAccess_(transferId);
  const t = getTransfer_(transferId);
  const up = readTable_('Uploads').filter(function (u) { return u.sessionId === sessionId; })[0];
  if (!t || !up || up.transferId !== t.id || up.status !== 'open') throw new Error('Upload not recognised.');

  const file = DriveApp.getFileById(fileId);
  if (!hasParent_(file, t.folderId)) throw new Error('File is not in this transfer.');

  file.setDescription('Uploaded by ' + up.uploaderName);
  setUploadStatus_(sessionId, 'done', fileId);
  return { ok: true };
}


// ===========================================================================
// Download gate
// ===========================================================================

function handleDownload_(transferId, fileId, token) {
  const rec = parseTok_(token);
  if (!rec || rec.tid !== transferId) return errorPage_(VERIFY_);
  const t = getTransfer_(transferId);
  if (!t || !canAccess_(t, rec.email)) return errorPage_(NOT_INVITED_);
  if (!isActive_(t)) return errorPage_('This transfer has expired and been deleted.');

  let file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (err) {
    return errorPage_('This file is no longer available.');
  }
  if (file.isTrashed() || !hasParent_(file, t.folderId)) return errorPage_('This file is no longer available.');

  const eventId = Utilities.getUuid();
  appendRow_('Downloads', {
    eventId: eventId, transferId: t.id, fileId: fileId, fileName: file.getName(),
    downloaderName: rec.name, downloaderEmail: rec.email, at: new Date().toISOString()
  });

  // Every click is logged, but emails go out at most once per person per file per 10 minutes.
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  const uploader = uploaderOf_(fileId);
  const at = fmtDate_(new Date());
  const transferUrl = transferUrl_(t.id);
  const base = 'dl:' + t.id + ':' + fileId + ':' + bucket;
  sendOnce_(base + ':owner', ownerEmail_(), 'Downloaded: ' + file.getName(),
    mail_('A file was downloaded.', [
      rec.name + ' (' + rec.email + ') downloaded ' + file.getName() + ' from ' + t.title + ' at ' + at + '.'
    ], t, transferUrl, 'Open transfer'));
  if (uploader && uploader !== ownerEmail_()) {
    sendOnce_(base + ':uploader', uploader, 'Downloaded: ' + file.getName(),
      mail_('Your file was downloaded.', [
        rec.name + ' (' + rec.email + ') downloaded ' + file.getName() + ' at ' + at + '.'
      ], t, transferUrl, 'Open transfer'));
  }
  sendOnce_(base + ':downloader', rec.email, 'Your download has started: ' + file.getName(),
    mail_('Your download has started.', [
      'Hello ' + rec.name + ',',
      'Your download of ' + file.getName() + ' has started. The files stay available until ' + fmtDate_(t.expiresAt) + ' (IST).'
    ], t, transferUrl, 'Open transfer'));

  // Google's own download address. Large files may show a virus-scan notice first.
  const target = 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(fileId) + '&export=download&confirm=t';
  return redirectPage_(target, file.getName());
}


// ===========================================================================
// Hourly job (time-driven trigger)
// ===========================================================================

function runHourlyJob() {
  releaseStaleUploads_();
  warnDue_();
  expireDue_();
}

/** Run once from the editor to schedule the hourly job. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    const fn = t.getHandlerFunction();
    if (fn === 'runHourlyJob' || fn === 'runDailyCleanup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runHourlyJob').timeBased().everyHours(1).create();
}

function warnDue_() {
  transfers_().forEach(function (t) {
    if (!isActive_(t) || t.warnSentAt) return;
    if (Date.now() < t.expiresAt.getTime() - CONFIG.WARN_DAYS_BEFORE * DAY_MS) return;
    const deadline = fmtDate_(t.expiresAt);
    const body = mail_('Files expire soon.', [
      'The files for ' + t.title + ' will be permanently deleted on ' + deadline + ' (IST).',
      'Download anything you need before then.'
    ], t, transferUrl_(t.id), 'Open transfer');
    t.recipients.concat([ownerEmail_()]).forEach(function (e) {
      sendOnce_('warn:' + t.id + ':' + e, e, 'Expires in 2 days: ' + t.title, body);
    });
    setField_('Transfers', t.row, 'warnSentAt', new Date().toISOString());
  });
}

function expireDue_() {
  transfers_().forEach(function (t) {
    if (t.status !== 'active' || Date.now() < t.expiresAt.getTime()) return;
    try {
      finishDeletion_(t);
    } catch (err) {
      console.error('Deletion failed for transfer ' + t.id + ': ' + err);
    }
  });
}

/** Deletes the folder and its files, then marks the transfer and removes personal details. */
function finishDeletion_(t) {
  purgeFolder_(t.folderId);
  setField_('Transfers', t.row, 'status', 'deleted');
  setField_('Transfers', t.row, 'deletedAt', new Date().toISOString());
  scrubPersonalData_(t.id);

  const body = mail_('Files removed.', [
    'The files for ' + t.title + ' were permanently deleted on ' + fmtDate_(new Date()) + '.',
    'They cannot be recovered. If you still need them, reply to this email.'
  ], t, null, null);
  t.recipients.concat([ownerEmail_()]).forEach(function (e) {
    sendOnce_('del:' + t.id + ':' + e, e, 'Files removed: ' + t.title, body);
  });
  setField_('Transfers', t.row, 'recipients', '[removed]');
}


function purgeFolder_(folderId) {
  const ids = [];
  try {
    const it = DriveApp.getFolderById(folderId).getFiles();
    while (it.hasNext()) ids.push(it.next().getId());
  } catch (err) {
    if (!isNotFound_(err)) throw err;
  }
  ids.forEach(function (id) { Drive.Files.delete(id); });
  try {
    Drive.Files.delete(folderId);
  } catch (err) {
    if (!isNotFound_(err)) throw err;
  }
}

/** Keeps counts and timestamps, drops names and emails of people who downloaded or uploaded. */
function scrubPersonalData_(transferId) {
  readTable_('Downloads').forEach(function (d) {
    if (d.transferId !== transferId) return;
    setField_('Downloads', d._row, 'downloaderName', '[removed]');
    setField_('Downloads', d._row, 'downloaderEmail', '[removed]');
  });
  readTable_('Uploads').forEach(function (u) {
    if (u.transferId !== transferId) return;
    setField_('Uploads', u._row, 'uploaderName', '[removed]');
    setField_('Uploads', u._row, 'uploaderEmail', '[removed]');
  });
  // Notification rows hold addresses in the "to" and "key" columns.
  readTable_('Notifications').forEach(function (n) {
    if (String(n.key).indexOf(transferId) === -1) return;
    setField_('Notifications', n._row, 'to', '[removed]');
    setField_('Notifications', n._row, 'key', 'done:' + transferId + ':' + n._row);
  });
}


function releaseStaleUploads_() {
  const cutoff = Date.now() - CONFIG.UPLOAD_RESERVATION_HOURS * HOUR_MS;
  readTable_('Uploads').forEach(function (u) {
    if (u.status === 'open' && new Date(u.createdAt).getTime() < cutoff) {
      setField_('Uploads', u._row, 'status', 'stale');
    }
  });
}

// ===========================================================================
// Access
// ===========================================================================

const NOT_INVITED_ = 'This email is not on the invited list for this transfer. Use the address the link was sent to, or ask the sender to add you.';

function checkVisitor_(name, email) {
  const n = clean_(name, 80);
  const e = cleanEmail_(email);
  if (!n) throw new Error('Please enter your name.');
  if (!isValidEmail_(e)) throw new Error('Please enter a valid email address.');
  return { name: n, email: e };
}

function canAccess_(t, email) {
  // Only people on the invited list. The owner uses the owner key instead.
  return !!email && t.recipients.indexOf(email) !== -1;
}


function isActive_(t) {
  return t.status === 'active' && Date.now() < t.expiresAt.getTime();
}

function isOwner_() {
  const e = activeEmail_();
  return !!e && e === ownerEmail_();
}


function requireOwner_() {
  if (!ownerKeyOk_()) throw new Error('This page is for the account owner only.');
}


function activeEmail_() {
  return cleanEmail_(Session.getActiveUser().getEmail());
}

function ownerEmail_() {
  return cleanEmail_(Session.getEffectiveUser().getEmail());
}

// ===========================================================================
// Transfers and files
// ===========================================================================

function transfers_() {
  return readTable_('Transfers').map(function (r) {
    const expires = new Date(r.expiresAt);
    if (!r.id || isNaN(expires)) return null;
    return {
      row: r._row,
      id: String(r.id),
      title: String(r.title || ''),
      folderId: String(r.folderId),
      recipients: String(r.recipients || '').split(',').filter(Boolean),
      createdAt: new Date(r.createdAt),
      expiresAt: expires,
      status: String(r.status || ''),
      warnSentAt: r.warnSentAt ? String(r.warnSentAt) : ''
    };
  }).filter(function (t) { return t; });
}

function getTransfer_(id) {
  if (!id) return null;
  return transfers_().filter(function (t) { return t.id === id; })[0] || null;
}

function mustGetTransfer_(id) {
  const t = getTransfer_(id);
  if (!t) throw new Error('Transfer not found.');
  return t;
}

function detail_(t) {
  const active = isActive_(t);
  const files = active ? listFiles_(t.folderId) : [];
  return {
    id: t.id,
    title: t.title,
    active: active,
    expiresAt: t.expiresAt.toISOString(),
    daysLeft: Math.max(0, Math.ceil((t.expiresAt.getTime() - Date.now()) / DAY_MS)),
    usedBytes: files.reduce(function (s, f) { return s + f.size; }, 0),
    maxBytes: CONFIG.MAX_TRANSFER_BYTES,
    gateBase: publicUrl_(),
    files: files
  };
}

function listFiles_(folderId) {
  const out = [];
  const it = DriveApp.getFolderById(folderId).getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    out.push({
      id: f.getId(),
      name: f.getName(),
      size: f.getSize(),
      uploaded: f.getDateCreated().toISOString(),
      uploadedBy: f.getDescription() || ''
    });
  }
  return out.sort(function (a, b) { return a.uploaded < b.uploaded ? 1 : -1; });
}

function folderBytes_(folderId) {
  const it = DriveApp.getFolderById(folderId).getFiles();
  let total = 0;
  while (it.hasNext()) total += it.next().getSize();
  return total;
}

function reservedBytes_(transferId) {
  const cutoff = Date.now() - CONFIG.UPLOAD_RESERVATION_HOURS * HOUR_MS;
  return readTable_('Uploads')
    .filter(function (u) {
      return u.transferId === transferId && u.status === 'open' && new Date(u.createdAt).getTime() > cutoff;
    })
    .reduce(function (s, u) { return s + Number(u.size || 0); }, 0);
}

function uploaderOf_(fileId) {
  const up = readTable_('Uploads').filter(function (u) { return u.fileId === fileId && u.status === 'done'; })[0];
  return up ? cleanEmail_(up.uploaderEmail) : '';
}

function setUploadStatus_(sessionId, status, fileId) {
  const row = readTable_('Uploads').filter(function (u) { return u.sessionId === sessionId; })[0];
  if (!row) return;
  setField_('Uploads', row._row, 'status', status);
  if (fileId) setField_('Uploads', row._row, 'fileId', fileId);
}

function hasParent_(file, folderId) {
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === folderId) return true;
  }
  return false;
}

function listForOwner_() {
  const downloads = readTable_('Downloads');
  const uploads = readTable_('Uploads');
  return transfers_().map(function (t) {
    const mine = downloads.filter(function (d) { return d.transferId === t.id; });
    const last = mine.map(function (d) { return new Date(d.at); })
      .filter(function (d) { return !isNaN(d); })
      .sort(function (a, b) { return b - a; })[0];
    const status = isActive_(t) ? 'active' : (t.status === 'active' ? 'expired' : t.status);
    return {
      id: t.id,
      title: t.title,
      status: status,
      expiresAt: t.expiresAt.toISOString(),
      url: transferUrl_(t.id),
      recipients: t.recipients.join(', '),
      uploads: uploads.filter(function (u) { return u.transferId === t.id && u.status === 'done'; }).length,
      downloads: mine.length,
      lastDownload: last ? last.toISOString() : ''
    };
  }).sort(function (a, b) { return a.expiresAt < b.expiresAt ? 1 : -1; });
}

// ===========================================================================
// Sheets registry (in the owner's Drive)
// ===========================================================================

function getSS_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('REGISTRY_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create(CONFIG.REGISTRY_NAME);
  props.setProperty('REGISTRY_ID', ss.getId());
  return ss;
}

function sheet_(name) {
  const ss = getSS_();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) sh.appendRow(SHEETS[name]);
  return sh;
}

function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const head = values[0];
  const out = [];
  for (let i = 1; i < values.length; i++) {
    if (!values[i][0]) continue;
    const o = { _row: i + 1 };
    head.forEach(function (k, j) { o[k] = values[i][j]; });
    out.push(o);
  }
  return out;
}

function appendRow_(name, obj) {
  sheet_(name).appendRow(SHEETS[name].map(function (k) {
    return obj[k] === undefined ? '' : obj[k];
  }));
}

function setField_(name, row, field, value) {
  const sh = sheet_(name);
  const col = SHEETS[name].indexOf(field) + 1;
  sh.getRange(row, col).setValue(value);
}

/** Sends a message once per key. The Notifications sheet is the record of what was sent. */
function sendOnce_(key, to, subject, htmlBody) {
  if (!to) return;
  const already = readTable_('Notifications').some(function (n) { return n.key === key && !n.error; });
  if (already) return;
  try {
    MailApp.sendEmail({ to: to, subject: subject, htmlBody: htmlBody, replyTo: ownerEmail_(), name: CONFIG.BRAND });
    appendRow_('Notifications', { key: key, to: to, sentAt: new Date().toISOString(), error: '' });
  } catch (err) {
    appendRow_('Notifications', { key: key, to: to, sentAt: '', error: String(err) });
  }
}

// ===========================================================================
// Drive folders, URLs and small helpers
// ===========================================================================

function getRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROOT_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (err) { /* recreate below */ }
  }
  const folder = DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
  props.setProperty('ROOT_FOLDER_ID', folder.getId());
  return folder;
}

/** Public address clients use. Set once in Script Properties as PUBLIC_URL (see README). */
function publicUrl_() {
  const url = PropertiesService.getScriptProperties().getProperty('PUBLIC_URL');
  if (!url) throw new Error('Set PUBLIC_URL in Script Properties to the public web app address (see README).');
  return url;
}

function publicUrlOrEmpty_() {
  return PropertiesService.getScriptProperties().getProperty('PUBLIC_URL') || '';
}

function transferUrl_(id) {
  // Links in emails open the web page (PAGE_URL) when it is set; otherwise the Apps Script page.
  const page = PropertiesService.getScriptProperties().getProperty('PAGE_URL') || publicUrl_();
  return page + '?t=' + encodeURIComponent(id);
}

function isNotFound_(err) {
  return /not found|notFound|404/i.test(String(err));
}

function mail_(heading, paragraphs, t, url, label) {
  let html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;line-height:1.5">';
  html += '<h2 style="font-size:20px;margin:0 0 12px">' + escape_(heading) + '</h2>';
  paragraphs.forEach(function (p) {
    if (p) html += '<p style="margin:0 0 12px">' + escape_(p) + '</p>';
  });
  if (url) {
    html += '<p style="margin:20px 0"><a href="' + escape_(url) + '" style="background:#111;color:#fff;' +
      'padding:10px 16px;border-radius:6px;text-decoration:none">' + escape_(label || 'Open') + '</a></p>';
  }
  html += '<p style="color:#666;font-size:12px;margin-top:24px">' + escape_(t.title) +
    ' · Available until ' + escape_(fmtDate_(t.expiresAt)) + ' (IST). Files are deleted after ' +
    CONFIG.EXPIRY_DAYS + ' days.<br>' + escape_(CONFIG.BRAND) + '</p></div>';
  return html;
}

function redirectPage_(target, fileName) {
  const html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="refresh" content="1;url=' + escape_(target) + '">' +
    '<title>Downloading</title></head>' +
    '<body style="font-family:Arial,sans-serif;padding:32px;color:#111">' +
    '<h2 style="margin:0 0 8px">Your download is starting</h2>' +
    '<p>' + escape_(fileName) + '</p>' +
    '<p>If it does not start, <a href="' + escape_(target) + '">click here</a>. If Google shows a warning about this file, choose <b>Download anyway</b>.</p>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('Downloading');
}

function errorPage_(message) {
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vivid Transfer</title></head>' +
    '<body style="font-family:Arial,sans-serif;padding:32px;color:#111"><h2>Unavailable</h2><p>' +
    escape_(message) + '</p></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('Vivid Transfer');
}

function parseEmails_(text) {
  const seen = {};
  return String(text || '')
    .split(/[\s,;]+/)
    .map(cleanEmail_)
    .filter(function (s) {
      if (!isValidEmail_(s) || seen[s]) return false;
      seen[s] = true;
      return true;
    });
}

function isValidEmail_(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function cleanEmail_(s) {
  return String(s || '').trim().toLowerCase();
}

function clean_(s, max) {
  return String(s || '').replace(/[\\\/\x00-\x1f<>]/g, '').trim().slice(0, max);
}

function escape_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtDate_(d) {
  return Utilities.formatDate(d, CONFIG.TZ, 'd MMM yyyy, h:mm a');
}


// ===========================================================================
// JSON API for the separate web page (JSONP, so it works across websites)
// ===========================================================================

const API_ACTIONS_ = {
  getPageState: getPageState,
  getTransferView: getTransferView,
  createTransfer: createTransfer,
  createUploadSession: createUploadSession,
  confirmUpload: confirmUpload,
  updateRecipients: updateRecipients,
  deleteTransferNow: deleteTransferNow,
  requestCode: requestCode,
  verifyCode: verifyCode
};

function apiResponse_(p) {
  const cb = String(p.callback || '').replace(/[^\w$]/g, '');
  let out;
  REQ_AUTH_ = { key: String(p.key || ''), token: String(p.token || '') };
  try {
    const fn = API_ACTIONS_[p.action];
    if (!fn) throw new Error('Unknown action.');
    const args = JSON.parse(p.args || '[]');
    out = { ok: true, data: fn.apply(null, args) };
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  if (!cb) return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
  return ContentService.createTextOutput(cb + '(' + JSON.stringify(out) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}



// ===========================================================================
// Access: owner key, or a session token after emailing a one-time code
// ===========================================================================

var REQ_AUTH_ = { key: '', token: '' };   // set for each web request by apiResponse_ / doGet
const VERIFY_ = 'Please confirm your email address to continue.';

/** The owner must send the OWNER_KEY secret (kept in the owner's browser only). */
function ownerKeyOk_() {
  const k = PropertiesService.getScriptProperties().getProperty('OWNER_KEY');
  return !!k && REQ_AUTH_.key === k && isOwner_();
}

function parseTok_(token) {
  if (!token) return null;
  const raw = CacheService.getScriptCache().get('tok:' + String(token));
  return raw ? JSON.parse(raw) : null;
}

/** Works out who is asking for a transfer: the owner (key) or a verified visitor (token). */
function resolveAccess_(transferId) {
  if (ownerKeyOk_()) return { owner: true, email: ownerEmail_(), name: '' };
  const rec = parseTok_(REQ_AUTH_.token);
  if (!rec) throw new Error(VERIFY_);
  if (rec.tid !== transferId) throw new Error(NOT_INVITED_);
  const t = getTransfer_(transferId);
  if (!t || !canAccess_(t, rec.email)) throw new Error(NOT_INVITED_);
  return { owner: false, email: rec.email, name: rec.name };
}

/** Step 1: email a 6-digit code, only if the address is invited. Always answers the same way. */
function requestCode(transferId, name, email) {
  const n = clean_(name, 80);
  const e = cleanEmail_(email);
  if (!n) throw new Error('Please enter your name.');
  if (!isValidEmail_(e)) throw new Error('Please enter a valid email address.');
  const t = getTransfer_(transferId);
  if (t && isActive_(t) && canAccess_(t, e)) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    CacheService.getScriptCache().put('code:' + transferId + ':' + e,
      JSON.stringify({ code: code, name: n, tries: 0 }), 600);
    MailApp.sendEmail({
      to: e,
      subject: 'Your code: ' + t.title,
      htmlBody: mail_('Your confirmation code', [
        'Enter this code to open ' + t.title + ':',
        '<b style="font-size:24px;letter-spacing:4px">' + code + '</b>',
        'The code expires in 10 minutes. If you did not ask for it, you can ignore this email.'
      ], t, null, null),
      replyTo: ownerEmail_(),
      name: CONFIG.BRAND
    });
  }
  return { sent: true };
}

/** Step 2: check the code and hand back a session token for this transfer (6 hours). */
function verifyCode(transferId, email, code) {
  const e = cleanEmail_(email);
  const cache = CacheService.getScriptCache();
  const key = 'code:' + transferId + ':' + e;
  const raw = cache.get(key);
  if (!raw) throw new Error('That code has expired. Request a new one.');
  const rec = JSON.parse(raw);
  if (rec.tries >= 5) {
    cache.remove(key);
    throw new Error('Too many attempts. Request a new code.');
  }
  if (String(code || '').trim() !== rec.code) {
    rec.tries++;
    cache.put(key, JSON.stringify(rec), 600);
    throw new Error('That code is not right. Check the email and try again.');
  }
  cache.remove(key);
  const t = getTransfer_(transferId);
  if (!t || !isActive_(t) || !canAccess_(t, e)) throw new Error(NOT_INVITED_);
  const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
  cache.put('tok:' + token, JSON.stringify({ tid: transferId, email: e, name: rec.name }), 21600);
  return { token: token };
}
