# Vivid Transfer: web page version (option 1)

The Apps Script page is blocked from uploading to Google Drive (CORS, confirmed in the browser console). This version runs the page on its own website and calls Apps Script through JSONP. Apps Script still does all the logic: transfers, Drive folders, notifications, downloads, and the 15-day deletion.

## Owner key (required)

The owner page is protected by a secret key, so a copy of the page on another site cannot read your transfers even while you are signed in to Google.

1. Make up a long random string (at least 24 characters). Keep it private.
2. In Apps Script: **Project Settings > Script Properties > Add property**. Name: `OWNER_KEY`. Value: your random string.
3. Redeploy the OWNER deployment (Manage deployments > Edit > New version).
4. Open your owner page with `?owner=1` at the end of the URL. The browser asks for the key once and keeps it in this browser only. Use a different browser or clear site data and you will be asked again.

## Testing visitor downloads

Visitors must be on a transfer's recipient list. To test the download as yourself, add your own second email address to the recipients, then open the public link in a private window. The visitor types a name and email, receives a 6-digit code by email, and enters it. The code expires after 10 minutes. After five wrong tries you must request a new code.

## Files
| File | Where it goes |
|---|---|
| `Code.gs` | Apps Script editor (replaces the old Code.gs) |
| `index.html` | Your free website (see step 2) |
| `appsscript.json` | Apps Script editor (same as before) |

## Steps

**1. Update Apps Script**
- Replace the contents of `Code.gs` with the new file. Save.
- Deploy > Manage deployments. On **both** deployments (owner and public) click Edit > **New version** > Deploy. The two addresses stay the same.
- Script Properties: add **`PAGE_URL`** = the address of your website page from step 2, for example `https://yourname.github.io/vivid-transfer/`. Keep `PUBLIC_URL` as it is (the Apps Script public address ending in `/exec`).

**2. Put `index.html` on a free website**
Easiest is GitHub Pages:
1. Create a free account at github.com and a new **public** repository, for example `vivid-transfer`.
2. Upload `index.html` to it.
3. Settings > Pages > Source: **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. After a minute the page is at `https://YOURNAME.github.io/vivid-transfer/`.

**3. Put the two Apps Script addresses into `index.html`**
Open `index.html` and replace:
- `PASTE_OWNER_DEPLOYMENT_URL` with the **owner** address (the "Only myself" deployment, ending in `/exec`).
- `PASTE_PUBLIC_DEPLOYMENT_URL` with the **public** address (the "Anyone" deployment, ending in `/exec`).

Upload the edited `index.html` again to GitHub.

## Test
1. Open the owner address in the page: `https://YOURNAME.github.io/vivid-transfer/`. You should see the Send screen. Owner sign-in must work in that browser, so sign in to Google in the same browser first.
2. Send a small file to a second account. The upload should reach 100%.
3. Open the link from the email. It should open the new page. Enter the invited email, check the file list, and download.

## Known limits
- The upload goes straight from the web page to Google Drive. Whether Google accepts that from a normal website is the thing this version has to prove. If the upload fails again, copy the DevTools console message.
- Owner sign-in works through the browser's Google session. If the owner page says it's not the owner, it's usually because the browser is signed in to another Google account, or blocks third-party cookies.
- A Google account is not needed to open a transfer link; the name and invited email are.
