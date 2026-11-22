# Bitcoin Cats platform viewer counts

This Cloudflare Worker reads live viewer counts from the official Twitch, YouTube and Kick APIs, plus Rumble's account-specific Live Stream API. The website calls the same-origin endpoint:

`GET https://bitcoin-cats.ca/api/platform-viewers`

The Worker is read-only. It does not publish, change stream settings, or access chat. Provider credentials remain in Cloudflare Worker secrets and are never sent to the browser.

## Handles configured in the Worker

- Twitch: `craigthespacebum`
- YouTube: `@craigthespacebum`
- Kick: `craigthespacebum`
- Rumble: account-specific Live Stream API URL belonging to `Craigthespacebum`

## Deploy from the Cloudflare dashboard

The Worker is deployed to the Cloudflare account for `bitcoin-cats.ca`. Provider credentials must still be added as Worker secrets in Cloudflare before live viewer counts can be retrieved. The public website never receives these credentials.

1. Open **Workers & Pages** and create a Worker named `bitcoin-cats-platform-viewers`.
2. Connect it to this GitHub repository, or create the Worker from the files in this folder. Set the Worker root directory to `workers/platform-viewers`; use `npx wrangler deploy` as the build/deploy command if the dashboard asks for one. The `wrangler.toml` file contains the route.
3. In the Worker settings, open **Variables and Secrets** and add the following as **Secrets**, not plain text variables:

   | Secret name | Where it comes from |
   | --- | --- |
   | `TWITCH_CLIENT_ID` | Your Twitch developer application |
   | `TWITCH_CLIENT_SECRET` | The secret for that Twitch application |
   | `YOUTUBE_API_KEY` | Google Cloud project with YouTube Data API v3 enabled |
   | `KICK_CLIENT_ID` | Your Kick developer application |
   | `KICK_CLIENT_SECRET` | The secret for that Kick application |
   | `RUMBLE_LIVE_API_URL` | Your private Rumble Live Stream API URL |

4. Deploy the Worker. Confirm that its route is `bitcoin-cats.ca/api/platform-viewers*` and that the DNS record for the zone is proxied through Cloudflare. The route must not replace or intercept any other site path.
5. Test `https://bitcoin-cats.ca/api/platform-viewers`. It should return JSON with `platforms.twitch`, `platforms.youtube`, `platforms.kick`, and `platforms.rumble`.

## Creating the API credentials

- **Twitch:** create an application in the Twitch developer console and copy its Client ID and Client Secret. The Worker obtains an app access token using the client-credentials flow and calls Helix Get Streams.
- **YouTube:** enable YouTube Data API v3 in Google Cloud and create an API key. Restrict the key to YouTube Data API v3. The Worker finds the channel uploads playlist, checks recent uploaded videos for an active live broadcast, and reads `liveStreamingDetails.concurrentViewers`. The field is absent when YouTube does not provide a public count; the Worker displays an unknown count rather than inventing zero.
- **Kick:** create a Kick developer application and use its Client ID and Client Secret. The Worker obtains an app access token and reads `stream.is_live` and `stream.viewer_count` from the channel endpoint.
- **Rumble:** in your Rumble account, open the Live Stream API page and generate/copy its private API URL. Add the full URL as `RUMBLE_LIVE_API_URL`. Treat this URL like a password: do not paste it into chat, commit it to GitHub, or put it in website HTML. You can reset it from Rumble if it is exposed.

## Data and refresh behaviour

- The page polls about once per minute.
- The Worker caches the combined response at the edge for 45 seconds to reduce provider API calls.
- Offline channels are shown as `0`; hidden or missing public counts are shown as unavailable, not zero.
- The combined count is shown only when all four platform counts are known. It is a simple sum and is not deduplicated, so one person watching on multiple platforms can be counted more than once.
- API failures remain separate from offline status and do not get silently converted to zero.
- No credentials are present in the source code.

## Troubleshooting

The Worker response shows each platform's status independently:

- `setup_required`: a named secret has not been added.
- `error`: a configured provider request failed; check the secret and app/API access.
- `offline`: the account was found, but no current live broadcast was returned.
- `live`: a current broadcast is active; `viewerCount` can still be null if that platform hides or omits the public count.
