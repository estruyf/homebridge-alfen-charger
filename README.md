# homebridge-alfen-charger

Start and stop EV charging on an **Alfen Eve** wallbox from Apple HomeKit.

The plugin talks to the charger's local HTTPS API over your LAN. No cloud, no
back office, no OCPP.

---

## How pausing works

The Alfen API has no start/stop command. What it does have is a writable socket
current limit, `2129_0` (`OD_mainNormalMaxCurrent`).

IEC 61851 requires at least **6 A** for the charger to signal a valid duty cycle
on the pilot line. Set the limit below that and the car stops drawing; set it
back and the car resumes.

| Home app action | What the plugin writes |
| --- | --- |
| Charging **ON** | `2129_0` = your configured `chargeCurrent` (default 16 A) |
| Charging **OFF** | `2129_0` = 0 A |

Every write is read back and confirmed; if the value did not stick, the plugin
retries once before reporting a failure to HomeKit.

## The one-session problem

> [!IMPORTANT]
> The charger allows **one API session at a time**. While this plugin is logged
> in, the **Eve Connect** app cannot connect, and vice versa.

The plugin exposes a **Connected** switch that decides who holds the session:

- **On** — the plugin is logged in and polling. Charging can be controlled from
  HomeKit, and the Eve Connect app is locked out.
- **Off** — the plugin logs out and stops polling. Your phone can now use the
  Eve Connect app.

So: switch it **off** to use your phone, **on** to control charging from
HomeKit. It starts **on**.

While it is off the Charging switch still shows the last reading the plugin
took, but refuses changes — there is no session to write through.

If you switch it back on while the phone app is still connected, the charger
will refuse the login and the plugin retries with backoff. Close Eve Connect and
it recovers on its own, no restart needed.

## What you get in HomeKit

| Service | Type | Behaviour |
| --- | --- | --- |
| **Charging** | Switch | On/off writes the socket current limit. State reflects the limit read back from the charger. |
| **Charge Point** | Outlet | `On` mirrors the Charging switch, so either control works. `OutletInUse` is true when the car is actually drawing power. |
| **Connected** | Switch | On: the plugin holds the charger session and can control charging. Off: the session is released for the Eve Connect app. |

"Actually drawing power" is read from the meter (`2221_16`, real power sum) and
compared against `powerThreshold` (default 100 W). On units without a meter the
plugin falls back to the Mode 3 pilot state (`2501_4`), where C2/D2 mean the
vehicle has closed S2 and is taking power.

---

## Step 1: verify the API before you install anything

Run the probe from a machine on the same LAN. It logs in, reads the parameters
the plugin depends on, prints them, and logs out. **It writes nothing.**

```bash
git clone https://github.com/estruyf/homebridge-alfen-charger.git
cd homebridge-alfen-charger
npm install
npm run probe -- --host 192.168.1.50 --password 'your-charger-password'
```

The password can also come from the environment, which keeps it out of your
shell history:

```bash
ALFEN_PASSWORD='your-charger-password' npm run probe -- --host 192.168.1.50
```

Expected output:

```
  Charger
    Identity          ACE0123456
    Model             Eve Single Pro-line, 3 phase, display, type 2 socket
    Firmware          6.4.0-4192
    Sockets           1
    Licenses          LoadBalancing_Active, RFIDReader

  Current limit
    2129_0 normal max        16A   <- the plugin writes this
    212C_0 active max        16A

  Status
    2501_1 main state   Available
    2501_3 socket state Normal Operation
    2501_4 mode 3       A (no vehicle)

  Power
    2221_16 real power        0W
    ...

  Interpretation
    Charging allowed  yes  (limit >= 6A)
    Vehicle connected no
    Drawing power     no

  Certificate
    SHA-256           AB:CD:EF:...
```

Other options: `--debug` (prints every request and response, password
redacted), `--json`, `--username`, `--port`, `--timeout`, `--help`.

The probe runs from source via `ts-node`. After `npm run build` you can also run
the compiled version, which is handy on the Pi where dev dependencies may not be
installed:

```bash
node dist/probe.js --host 192.168.1.50 --password 'your-charger-password'
```

### If the probe fails

| Symptom | Likely cause |
| --- | --- |
| `login ... returned HTTP 401` | Wrong password. Use the charger's admin password, the same one Eve Connect uses. |
| `ECONNREFUSED` / timeout | Wrong IP, or the charger is not reachable from this machine. |
| Login succeeds but hangs | Eve Connect is holding the session. Close the app fully and retry. |

Copy the **certificate SHA-256** from the output if you want to pin it in the
plugin config (see `certificateFingerprint` below).

---

## Step 2: install on the Raspberry Pi

Node 20 or newer, Homebridge 1.8 or 2.x.

### Option A: install from a tarball via the Homebridge UI

On your development machine:

```bash
npm run build
npm pack          # produces homebridge-alfen-charger-1.0.0.tgz
```

Copy the tarball to the Pi, then on the Pi:

```bash
sudo hb-service add /path/to/homebridge-alfen-charger-1.0.0.tgz
```

Or install it into the Homebridge storage directory directly:

```bash
cd /var/lib/homebridge
sudo npm install /path/to/homebridge-alfen-charger-1.0.0.tgz
sudo hb-service restart
```

The plugin then appears in the Homebridge UI with its settings form.

### Option B: `npm link` for local development

Useful when you are iterating on the code on the Pi itself:

```bash
cd ~/homebridge-alfen-charger
npm install
npm run build
sudo npm link

# Homebridge must be able to see the linked package:
cd /var/lib/homebridge
sudo npm link homebridge-alfen-charger
sudo hb-service restart
```

While developing, `npm run watch` recompiles on save; restart Homebridge to pick
up changes.

> [!NOTE]
> `hb-service` runs Homebridge as the `homebridge` user with its storage in
> `/var/lib/homebridge`. If you installed Homebridge a different way, link into
> whichever directory holds your `config.json`.

---

## Step 3: configure

Use the Homebridge UI form, or add the platform block to `config.json` by hand:

```json
{
  "platforms": [
    {
      "platform": "AlfenCharger",
      "name": "Alfen Charger",
      "host": "192.168.1.50",
      "password": "your-charger-password",
      "chargeCurrent": 16,
      "pollInterval": 30
    }
  ]
}
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | `Alfen Charger` | Name shown in the Home app. |
| `host` | string | — | **Required.** Charger IP or hostname, without `https://`. |
| `password` | string | — | **Required.** The charger's admin password. |
| `chargeCurrent` | 6–32 | `16` | Current limit applied when Charging is switched on. |
| `pollInterval` | seconds | `30` | How often to read the charger. Minimum 10. |
| `debug` | boolean | `false` | Log requests and state changes. The password is never logged. |
| `requestTimeout` | 5–60 s | `15` | Per-request timeout. |
| `powerThreshold` | watts | `100` | Power above which `OutletInUse` is true. |
| `certificateFingerprint` | string | — | Optional SHA-256 pin for the charger's certificate. |

> [!WARNING]
> Set `chargeCurrent` to something your installation is actually rated for. The
> plugin will happily write 32 A if you ask it to.

---

## TLS and the self-signed certificate

The charger presents a self-signed certificate, so chain validation cannot
succeed. Rather than disabling TLS checks process-wide, the plugin:

1. Creates a **dedicated `https.Agent`** with `rejectUnauthorized: false` that is
   used only for requests to the configured host. `NODE_TLS_REJECT_UNAUTHORIZED`
   is never touched, so every other TLS connection in your Homebridge process is
   unaffected.
2. **Pins the certificate.** The first fingerprint seen is remembered, and any
   later connection presenting a different certificate is torn down. Set
   `certificateFingerprint` (the probe prints it) to pin from the first
   connection instead of trusting on first use.

If you replace the charger or reinstall its firmware, the fingerprint changes
and the plugin will refuse to connect. Clear `certificateFingerprint` and
restart.

---

## Being gentle with the charger

The Home Assistant integration reports that these chargers can become unstable
when polled hard. This plugin therefore:

- **Serialises every request** through a mutex. There is never more than one
  call in flight, and the HTTP agent is capped at a single socket.
- **Reuses the session** rather than logging in per request, and re-logs in only
  when the charger answers 401 or 403.
- **Reads only nine parameters** per poll, by id, instead of walking whole
  categories.
- **Backs off exponentially with jitter** on failure, from 5 s up to 5 minutes,
  and drops repeat failures to debug level so an offline charger does not flood
  the log.
- **Enforces a 10 s floor** on `pollInterval`.

---

## Adding a Modbus TCP backend later

All charger communication sits behind the `ChargerBackend` interface in
[`src/charger/types.ts`](src/charger/types.ts):

```ts
interface ChargerBackend {
  readonly kind: string;
  readonly isExclusive: boolean;   // HTTP: true. Modbus: false.
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getDeviceInfo(): Promise<ChargerDeviceInfo>;
  readState(): Promise<ChargerState>;
  setMaxCurrent(amps: number): Promise<void>;
}
```

`AlfenHttpBackend` is one implementation. A `AlfenModbusBackend` would be
another, and nothing in `accessory.ts` or `platform.ts` needs to change: the
accessory only ever calls these six methods.

Notes for that work:

- Modbus TCP on port **502**, socket slave id **1**.
- Max current is register **1210**, a `float32` (two registers, big-endian).
- Requires the **Active Load Balancing** licence. The probe prints the licence
  list; look for `LoadBalancing_Active`.
- Modbus does **not** block the Eve Connect app, so such a backend would set
  `isExclusive = false` and the accessory would omit the Connected switch.

---

## Development

```bash
npm install
npm run build      # compile to dist/
npm run watch      # compile on change
npm test           # unit tests
npm run lint
```

The tests cover the API client against a fake transport: the login payload and
headers, `ids=` reads, the write-and-verify path including the retry, session
recovery on 401/403, request serialisation, and the malformed-JSON workarounds.
No network access is needed to run them.

## API reference

Endpoints and parameter ids were verified against:

- [leeyuentuen/alfen_wallbox](https://github.com/leeyuentuen/alfen_wallbox) — the
  Home Assistant integration, in particular `alfen.py`, `const.py` and
  [`doc/alfen_props.md`](https://github.com/leeyuentuen/alfen_wallbox/blob/master/doc/alfen_props.md)
- [alfen_wallbox wiki: API paramID](https://github.com/leeyuentuen/alfen_wallbox/wiki/API-paramID)
- [LordGaav/alfen-eve](https://gitlab.com/LordGaav/alfen-eve) — Python client

The contract this plugin implements:

| Call | Details |
| --- | --- |
| Login | `POST /api/login` — `{"username":"admin","password":"...","displayname":"Homebridge"}`, `Content-Type: application/json` |
| Logout | `POST /api/logout` |
| Read | `GET /api/prop?ids=<id>[,<id>...]` → `{"version":2,"properties":[{id,value,...}],"total":n}` |
| Write | `POST /api/prop` — `{"<id>":{"id":"<id>","value":<v>}}` |
| Info | `GET /api/info` — no authentication required |

> [!NOTE]
> `alfen/json; charset=utf-8` is the content type the charger returns on GET
> responses. **Requests** must be sent as `application/json`. The plugin parses
> response bodies itself rather than relying on the content type, and repairs the
> two known firmware quirks: trailing commas and bare `nan` in meter values.

### Parameters used

| Id | Name | Use |
| --- | --- | --- |
| `2129_0` | `OD_mainNormalMaxCurrent` | Socket current limit — **written** to pause/resume |
| `212C_0` | `OD_mainActiveMaxCurrent` | Limit the charger is actually applying |
| `2501_1` | `socket1_StateMain` | Main state machine |
| `2501_3` | `socket1_StateSocket` | CPRO power state |
| `2501_4` | `socket1_StateMode3` | IEC 61851 pilot state |
| `2221_16` | `meter1_powerRealSum` | Real power, W |
| `2221_A/B/C` | `meter1_currentL1/L2/L3` | Per-phase current, A |
| `205E_0` | `OD_sysNumSockets` | Socket count (probe only) |
| `21A2_0` | `OD_sysFeatureEnabled` | Licence bitmask (probe only) |

## Licence

MIT
