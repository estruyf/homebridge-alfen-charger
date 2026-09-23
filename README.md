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
| Charging **ON** | `2129_0` = your configured `chargePower` (default 3.7 kW = 16 A) |
| Charging **OFF** | `2129_0` = 0 A |

Every write is read back and confirmed; if the value did not stick, the plugin
retries once before reporting a failure to HomeKit.

## The one-session problem

> [!IMPORTANT]
> The charger allows **one API session at a time**. While this plugin is logged
> in, the **Eve Connect** app cannot connect, and vice versa.

The plugin exposes a **Connection** tile that decides who holds the session:

- **On** — the plugin is logged in and polling. Charging can be controlled from
  HomeKit, and the Eve Connect app is locked out.
- **Off** — the plugin logs out and stops polling. Your phone can now use the
  Eve Connect app.

So: switch it **off** to use your phone, **on** to control charging from
HomeKit. It starts **on**.

While it is off the Charging tile still shows the last reading the plugin took,
but refuses changes — there is no session to write through.

If you switch it back on while the phone app is still connected, the charger
will refuse the login and the plugin retries with backoff. Close Eve Connect and
it recovers on its own, no restart needed.

## What you get in HomeKit

Two **separate accessories**, so each gets its own tile in the Home app and a
single tap does one thing:

| Tile | Type | Behaviour |
| --- | --- | --- |
| **Alfen Charger** | Outlet | Tap to start or stop charging — `On` writes the socket current limit, and the state reflects the limit read back from the charger. `OutletInUse` is true when the car is actually drawing power. |
| **Alfen Charger Connection** | Switch | On: the plugin holds the charger session and can control charging. Off: the session is released for the Eve Connect app. |

Both tiles are named after the `name` in your config, so setting `name` to
`Wallbox` gives you **Wallbox** and **Wallbox Connection**. Rename either one in
the Home app afterwards if you prefer something shorter.

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
      "chargePower": 3.7,
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
| `chargePower` | kW | `3.7` | Charge rate applied when the Charging tile is switched on, in kW — the same figure the Eve Connect app shows. |
| `nominalVoltage` | volts | `230` | Voltage used to convert kW to amps. |
| `pollInterval` | seconds | `30` | How often to read the charger. Minimum 10. |
| `debug` | boolean | `false` | Log requests and state changes. The password is never logged. |
| `requestTimeout` | 5–60 s | `15` | Per-request timeout. |
| `powerThreshold` | watts | `100` | Power above which `OutletInUse` is true. |
| `certificateFingerprint` | string | — | Optional SHA-256 pin for the charger's certificate. |

> [!WARNING]
> Set `chargePower` to something your installation is actually rated for. The
> plugin will happily write 32 A if you ask it to.

> [!NOTE]
> `chargeCurrent` (in amps) from earlier versions is still accepted, so an
> existing config keeps working. If both are present, `chargePower` wins.

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

## The Eve Connect "Power Settings" screen

Everything on that screen is stored in the charger as ordinary parameters, so
you can read them with the probe and write them with `POST /api/prop`.

| App control | Parameter | Values |
| --- | --- | --- |
| **Maximum Power** slider | `2129_0` `OD_mainNormalMaxCurrent` | Amps. The app shows it as kW. |
| **Solar Charging** toggle *and* Comfort/Green choice | `3280_1` `OD_sysSolarCharging.operationMode` | `0` off, `1` Comfort, `2` Green |
| Green mode surplus threshold | `3280_2` `OD_sysSolarCharging.greenShare` | 0–100 % |
| Comfort minimum charge rate | `3280_3` `OD_sysSolarCharging.comfortLevel` | Watts. Max 3300 on 1-phase, 11000 on 3-phase. |
| Solar boost | `3280_4` `OD_sysSolarCharging.overrideSocket1` | 0 / 1 |

Note that the toggle and the Comfort/Green radio buttons are **one parameter**,
not two: turning the toggle off writes `0`.

`npm run probe` prints all of these, so you can compare them against what the
app shows.

### Maximum Power is the same setting this plugin writes

You configure this plugin in kW, exactly like the app's slider. The charger
stores amps, so the plugin converts, using the phase count the charger reports
in `312E_0` and a nominal 230 V:

| 1 phase | 3 phase | `2129_0` |
| --- | --- | --- |
| 1.4 kW | 4.1 kW | 6 A — the minimum that charges at all |
| 3.7 kW | 11 kW | 16 A |
| 5.0 kW | 15 kW | 22 A |
| 7.4 kW | 22 kW | 32 A |

So whatever kW you had selected in the app, put the same number in
`chargePower`.

Because the charger only stores whole amps, the rate you get back is not always
the rate you asked for: 5.0 kW becomes 22 A, which is really 5.1 kW. The log
reports what was actually applied rather than what you asked for.

If the kW you configure falls outside what the socket can deliver, the plugin
clamps it to the 6–32 A range and warns once, naming the usable range for your
phase count.

> [!NOTE]
> kW is always a derived figure — the charger holds amps, and the exact voltage
> the app assumes is not documented. Run the probe and compare `2129_0` against
> the slider to confirm the mapping on your unit. If your grid voltage differs
> markedly from 230 V, set `nominalVoltage`.

### How solar charging interacts with this plugin

This matters, because in one mode the charger will overrule HomeKit.

| Mode (`3280_1`) | Turning Charging **on** in HomeKit |
| --- | --- |
| **Disabled** (`0`) | Charges at `chargePower`. Predictable. |
| **Comfort** (`1`) | Charges at least the comfort level even without sun, topping up with surplus. Predictable. |
| **Green** (`2`) | Sets a *ceiling* only. The charger still waits for solar surplus, so the car may not start charging at all. |

In **Green** mode the plugin will report the write as successful — and it is,
`2129_0` really did change — but the car will not draw power until there is
surplus. `OutletInUse` correctly stays off. If you want the Charging tile to
mean "charge now", use **Comfort** or **Disabled**.

Turning Charging **off** works in every mode: 0 A is below the 6 A minimum, so
the pilot signal stops regardless of what solar charging wants.

The `212C_0` reading in the probe output is useful here — it is the limit the
charger is *actually* applying, so in Green mode you will see it sitting below
`2129_0` when there is no surplus.

### Changing solar settings

This plugin only reads these parameters; it never writes them. Change them in
the Eve Connect app (turn the **Connection** switch off first so the app can log
in), or write them yourself:

```bash
# Switch to Comfort mode with a 1.4 kW floor
curl -sk -X POST https://192.168.1.50/api/prop \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"3280_1":{"id":"3280_1","value":"1"}}'
```

(You need to `POST /api/login` first and keep the session cookie; the probe's
`--debug` output shows the exact sequence.)

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
  `isExclusive = false` and the plugin would omit the Connection accessory.

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
