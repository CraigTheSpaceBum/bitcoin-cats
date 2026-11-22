# Bitcoin Cats platform viewer counts

This Cloudflare Worker reads live viewer counts from the official Twitch, YouTube and Kick APIs, plus Rumble's account-specific Live Stream API. The website calls the API service at `https://api.bitcoin-cats.ca`:

`GET https://bitcoin-cats.ca/api/platform-viewers`

The Worker keeps provider credentials and Twitch OAuth tokens on Cloudflare. It reads public stream data and live chat/notification events; it does not send messages or change stream settings. The Nostr composer remains separate.

## Handles configured in the Worker

- Twitch: `craigthespacebum` (followers + chat/notifications after broadcaster OAuth authorization)
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

4. Deploy the Worker. Its custom domain is `api.bitcoin-cats.ca`, which serves the platform API and Twitch/Kick webhook callbacks. The Worker returns 404 for unknown paths.
5. Test `https://api.bitcoin-cats.ca/api/platform-viewers`. It should return JSON with `platforms.twitch`, `platforms.youtube`, `platforms.kick`, and `platforms.rumble`.

## Creating the API credentials

- **Twitch:** create a **Confidential** application in the Twitch developer console. Set its OAuth Redirect URL to exactly `https://api.bitcoin-cats.ca/api/twitch/callback`. Add `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` as Worker secrets. Then open `https://api.bitcoin-cats.ca/api/twitch/auth` (or use the About page's Connect Twitch link) and authorize the channel owner account `craigthespacebum`. The requested user scopes are `user:read:chat` and `moderator:read:followers`. The OAuth access and refresh tokens, EventSub signing secret, and recent chat events are stored in the private `TWITCH_AUTH` KV namespace; they are not sent to the browser. The Worker uses an app token for viewer counts and the broadcaster's user token for the follower total and EventSub chat/message notifications. Twitch Bits cheers and chat notices are labelled in the combined chat.
- **YouTube:** enable YouTube Data API v3 in Google Cloud and create an API key. Restrict the key to YouTube Data API v3. The Worker reads the channel subscriber total, finds active broadcasts and reads `liveStreamingDetails.concurrentViewers`. When YouTube exposes an active live-chat ID, it also reads recent public chat items, including Super Chats and membership notices. Hidden counts remain unavailable rather than being shown as zero.
- **Kick:** create a Kick developer application and use its Client ID and Client Secret. The Worker obtains an app access token and reads `stream.is_live` and `stream.viewer_count` from the channel endpoint. Kick's documented public channel API currently does not provide the follower total or a chat message feed, so those are shown as unavailable rather than being guessed or scraped.
- **Rumble:** in your Rumble account, open the Live Stream API page and generate/copy its private API URL. Add the full URL as `RUMBLE_LIVE_API_URL`. The Worker reads the total follower count and, while live, recent chat messages and Rants. Treat this URL like a password: do not paste it into chat, commit it to GitHub, or put it in website HTML. You can reset it from Rumble if it is exposed.

## Data and refresh behaviour

- The About page refreshes follower/subscriber counts about once per minute.
- The Live page combines Nostr chat and verified zaps with Twitch EventSub, Kick Event webhooks, YouTube live chat (including Super Chats and membership notices) and Rumble chat/Rants. It displays only the latest 15 entries across all available sources. Twitch and Kick event feeds require their respective app credentials and authorization/webhook configuration.
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
