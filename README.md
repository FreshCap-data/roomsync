# RoomSync

Play one computer's audio on every device in the room, in sync. Cloudflare Worker + Durable Object relay, plain-JS client.

## Deploy
    npm install
    npm run deploy

Open the printed URL. On desktop Chrome or Edge click "Share this computer's audio" (tick "Share audio" in the picker). On other devices open the same URL, use the same room name, tap "Listen on this device".

## How sync works
- Every device measures its clock offset to the Worker (ping/pong, average of the lowest-latency samples).
- The host stamps each 20 ms packet with the Worker's clock and sends the shared delay with it.
- Each listener schedules the packet on its own audio clock at stamp + delay + fine tune, using getOutputTimestamp() to account for speaker latency. Small drift is absorbed by a tiny playback-rate nudge; large errors hard-resync.

## Tuning
- Late packets rising: raise the shared delay (host slider). On a good LAN 40-80 ms works.
- A speaker sounds early or late (Bluetooth, some phones): use that device's fine-tune slider.
- Tab capture in Chrome mutes the host tab; tick "Also play here" so the host stays in sync. System-audio capture (Windows) cannot be muted, so the host plays ahead of the others.
- Only desktop Chrome/Edge can host. Phones can listen.

## Tests
    npm run test:sim                      # sync math against simulated clocks, drift, jitter (no server needed)
    npm run dev                           # in one terminal
    npm run test:relay                    # in another: relay, ordering, host replacement, clock pings

Simulated results (3 runs): LAN wobble between devices p99 under 0.7 ms; noisy network p99 1 to 3.5 ms; a device that under-reports its speaker latency stays offset by exactly that amount until you use its fine-tune slider.
Not covered by tests: real audio capture, real speakers/Bluetooth, real Wi-Fi.

## Free tier
The host sends about 50 messages/s (about 9,000 of the 100,000 daily Durable Object requests per hour, roughly 10 h/day). Raw 16-bit stereo is about 1.5 Mbps per listener; Opus would be the next upgrade.
