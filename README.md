# Anything but a Game Controller: Tilt Maze

This project turns a phone into a real-time motion controller for a browser game on a laptop. You tilt the phone to roll a ball through a maze, and you shake it (or tap JUMP) to hop over holes. Up to 8 phones can join the same game and race each other.

```
npm install
npm start
```

1. On the laptop, open **http://localhost:8080**. It shows a room code and a QR code.
2. On the phone (same Wi-Fi), scan the QR code. It opens `https://<laptop-ip>:8443/pad.html?room=CODE`.
3. Accept the self-signed certificate warning once (phones only give motion sensors to HTTPS pages), then tap **Connect**.
4. Hold the phone flat, tap **Calibrate**, and tilt to roll.

If your Wi-Fi blocks devices from talking to each other (common on campus networks), connect the laptop to the phone's hotspot instead. You can set `LAN_IP=x.x.x.x` to force the address shown in the QR code. On Windows, allow Node through the firewall when asked.

**App build:** the phone side is an installable PWA (`manifest.json` and a service worker). In Chrome on Android, use *Add to Home screen* / *Install app* to get a standalone app icon with no browser bar.

## Features

| Requirement | How it is done |
|---|---|
| Gyro + accelerometer mapping | `deviceorientation` gamma/beta map to steering, with ±25° for full speed and clamping. `devicemotion` with acceleration above 14 m/s² counts as a shake and makes the ball jump (700 ms cooldown). |
| Pairing | The server issues a 4-letter room code. The game shows a QR code pointing to the pad URL with the code built in, and you can also type the code by hand. |
| WebSocket streaming | The phone sends `{t:'s',x,y}` at 60 Hz, only when the value changes, plus a 250 ms keepalive. The server is a thin relay with no game logic. |
| Browser game | A ball-balancing tilt maze with walls, holes (fall means respawn), a finish flag, race timer and falls counter. Physics uses sub-stepping, so fast balls cannot pass through walls. |
| Calibration | **Calibrate** stores the current pose as neutral. It is saved in `localStorage`, so it survives reloads. |
| Connection status + auto-reconnect | Both sides show a status dot. Both reconnect with exponential backoff (300 ms up to 4 s). The phone has a stable device id, so it gets the same ball and color back. A reloaded game reclaims the same room code, so phones do not need to re-pair. A 5 s server heartbeat drops dead sockets quickly. |

**Bonus items done:**
- Local multiplayer: up to 8 phones, each with its own colored ball, racing in one maze
- On-screen JUMP button
- Vibration feedback: a bump scaled to impact speed when you hit a wall, a double buzz when you fall into a hole, and a pattern when you finish
- Live latency display on both the phone and the game
- Screen wake lock
- Arrow keys and space on the laptop, for testing without a phone

## Latency approach

- **Thin relay:** the server never parses game state. It tags the message with the phone id and forwards it, which takes well under 1 ms.
- **No compression** (`perMessageDeflate: false`) and Nagle is off (the `ws` default `noDelay`), so small packets go out immediately.
- **Latest value only:** the phone sends its current tilt every 16 ms. The game uses the newest value, so a delayed packet can never build up a queue of stale input.
- **Measured, not guessed:** every second the phone sends `ping{ts}`, the game echoes `pong{ts}`, and the phone shows round trip / 2. That number is also sent with the sensor packets, so the game shows each player's latency.

`npm test` runs an end-to-end check on a real server. It covers pairing, a bad code being rejected, relaying 500 sensor packets, haptics, phone reconnect keeping its color, game reload keeping the room, and that the maze is solvable. It also prints relay latency. On localhost: **p50 0.16 ms, p95 0.40 ms, p99 0.74 ms**. Over Wi-Fi, expect roughly 5–30 ms, and the pad shows the live value.

## Structure

```
server.js          HTTP + HTTPS static server and WebSocket relay (rooms, pairing, heartbeat)
public/index.html  laptop game (maze, physics, QR, players, haptics out)
public/pad.html    phone controller (sensors, calibration, jump, latency, reconnect)
public/manifest.json, sw.js, icon.svg   PWA install
test.js            end-to-end test + latency benchmark
```

Tech stack: Node.js, `ws`, `selfsigned` (generates the local HTTPS certificate), plain HTML/Canvas/JS on both clients, and qrcodejs from a CDN.
