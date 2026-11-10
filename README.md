# Steam Inventory Value & Listing Helper (browser extension)

This is the source code of the browser extension for [Steam Inventory Value](https://steam.2cstudio.app), exactly as uploaded to the Chrome Web Store (the `main` branch is the latest upload; each published version has a tag):
https://chromewebstore.google.com/detail/bdggedaolbocnacmanlcekmeggoefgmf

It is published so that anyone can check what the extension does before installing it. The website and its back end are not in this repository.

Steam Inventory Value is run by 2C Studio (https://2cstudio.app) and is not affiliated with Valve Corporation or Steam.

## What it does

- **Value check button.** On Steam inventory pages it shows a "Check this inventory's value" button. It is a plain link that opens steam.2cstudio.app when you press it.
- **Toolbar popup.** Links to the value check and to your orders.
- **Listing helper.** Only when you have placed a listing order on steam.2cstudio.app and pressed "List with the extension": it lists the items in that order on the Steam Community Market, from your own browser, a little under the current lowest price. You confirm every listing yourself in the Steam Mobile app. Afterwards it reports each item's status (listed, sold, removed) back to your order.

## What it cannot and does not do

- It never reads or sends your Steam password or Steam Guard codes.
- It never sends your Steam cookies or session ID to our site. The session ID is read from the Steam page and used only for requests from your browser to steamcommunity.com.
- It does not send trade offers.
- It cannot confirm a listing for you. Anything you don't confirm in the Steam Mobile app never goes on sale.
- It does not read your browsing history and runs on no site other than the two below.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Keeps the current listing job (the items of your order and their status) while it runs. |
| `https://steamcommunity.com/*` | Sends the listing requests, reads your own market listings and history to see what sold, and shows the value-check button on inventory pages. |
| `https://steam.2cstudio.app/*` | Receives the order's item list from the order page and reports each item's status back to it. |

## What is sent, and where

| To | What |
|---|---|
| steamcommunity.com | The same requests Steam's own "Sell" button sends (item, price, your session), plus price lookups and your own listings and history. |
| steam.2cstudio.app | For the items in your order only: app ID, context ID, asset ID, status and listing price, with a token that belongs to that order. |

Nothing else leaves your browser.

## Files

| File | Runs | Does |
|---|---|---|
| `manifest.json` | — | Permissions and where each script runs. |
| `background.js` | Service worker | Holds the current job, checks whether you are signed in to Steam, reports status to the order. |
| `site.js` | steam.2cstudio.app | Passes the order's listing plan from the order page to the extension. |
| `steam.js` | steamcommunity.com | The panel on Steam: checks live prices, sends listings, reads what sold. |
| `steam-main.js` | steamcommunity.com (page context) | Reads three page variables (session ID, Steam ID, wallet currency) and hands them to `steam.js` on the same page. |
| `lib.js` | steamcommunity.com | Price maths (Steam's fees, the list price), request throttling. |
| `inventory-cta.js` | Steam inventory pages | The value-check button. |
| `popup.html`, `popup.js` | Toolbar popup | Two links. |
| `i18n.js`, `_locales/` | — | English and Chinese text. |

## The package itself

`dist/` holds the exact file uploaded to the Chrome Web Store for each version, so you can unzip it and compare it with the files in this repository, or scan it with any tool you trust.

| Version | File | SHA-256 | Store status |
|---|---|---|---|
| 0.4.7 | `dist/steam-listing-helper-0.4.7.zip` | `3f33ff47d7e76ea91e277110e21b0506e9d20865e771d89fb9a65b26fad3140a` | Published |
| 0.4.8 | `dist/steam-listing-helper-0.4.8.zip` | `19f1888f6b3e03440ef32767d560761b59170dc15c26dda81a89e9a4007d4954` | Submitted 10 November 2026, in review |

0.4.8 changes only how amounts are shown: in the currency of your Steam Wallet as chosen on the order, instead of always in Malaysian Ringgit.

## Third-party scan

The 0.4.7 package was scanned on VirusTotal on 10 November 2026: none of the 65 security vendors flagged it ([report](https://www.virustotal.com/gui/file/3f33ff47d7e76ea91e277110e21b0506e9d20865e771d89fb9a65b26fad3140a)). An antivirus scan is not a code audit; the code is here for that.

## Checking that this is what you installed

1. Open `chrome://extensions`, turn on Developer mode and note the extension's ID and version.
2. The installed files are in your browser profile under `Extensions/<ID>/<version>/`. Compare them with the files here for the same version (see the tags of this repository).

## Contact

support@2cstudio.app

## Licence

Source-available: you can read this code and check it against what you installed, but not reuse, modify or redistribute it. See [LICENSE](LICENSE).
