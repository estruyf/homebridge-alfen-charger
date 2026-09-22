#!/usr/bin/env node
/**
 * Standalone probe: log in, read the interesting parameters, log out.
 *
 * Run this before installing the plugin to confirm the charger's API answers
 * the way this plugin expects.
 *
 *   npm run probe -- --host 192.168.1.50 --password 'secret'
 *   npm run probe -- --host 192.168.1.50 --password 'secret' --debug --json
 *
 * Nothing is written to the charger; this is read-only.
 */

import { extractProperties, parseAlfenJson, toNumber } from './charger/alfenJson';
import { NodeHttpsTransport } from './charger/http';
import { AlfenHttpBackend } from './charger/alfenHttpBackend';
import {
  MIN_CHARGE_CURRENT_A,
  PARAM,
  decodeLicenses,
  describeMainState,
  describeMode3,
  describePowerState,
} from './charger/params';
import { isChargingEnabled, isDrawingPower, isVehicleConnected } from './charger/state';
import type { ChargerDeviceInfo, ChargerState, Logger } from './charger/types';

interface ProbeArgs {
  host: string;
  password: string;
  username: string;
  port: number;
  timeoutMs: number;
  debug: boolean;
  json: boolean;
}

function usage(): string {
  return [
    'Usage: npm run probe -- --host <ip> --password <password> [options]',
    '',
    'Options:',
    '  --host <ip>          Charger IP address or hostname        (required)',
    '  --password <secret>  Charger admin password                (required)',
    '  --username <name>    Login user                            (default: admin)',
    '  --port <number>      HTTPS port                            (default: 443)',
    '  --timeout <seconds>  Per-request timeout                   (default: 15)',
    '  --debug              Print every request and response',
    '  --json               Print the results as JSON',
    '  --help               Show this message',
    '',
    'The password may also be supplied via the ALFEN_PASSWORD environment variable.',
  ].join('\n');
}

function parseArgs(argv: string[]): ProbeArgs {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }

  if (args.help === true) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }

  const host = typeof args.host === 'string' ? args.host : '';
  const password =
    typeof args.password === 'string' ? args.password : (process.env.ALFEN_PASSWORD ?? '');

  if (host === '' || password === '') {
    process.stderr.write(`${usage()}\n\nError: --host and --password are required.\n`);
    process.exit(2);
  }

  return {
    host,
    password,
    username: typeof args.username === 'string' ? args.username : 'admin',
    port: typeof args.port === 'string' ? Number(args.port) : 443,
    timeoutMs: (typeof args.timeout === 'string' ? Number(args.timeout) : 15) * 1000,
    debug: args.debug === true,
    json: args.json === true,
  };
}

function makeLogger(debug: boolean): Logger {
  const write = (level: string, message: string) => {
    process.stderr.write(`${level} ${message}\n`);
  };
  return {
    debug: (message: string) => {
      if (debug) {
        write('[debug]', message);
      }
    },
    info: (message: string) => write('[info] ', message),
    warn: (message: string) => write('[warn] ', message),
    error: (message: string) => write('[error]', message),
  };
}

/** Parameters the probe reads, beyond the ones the plugin polls. */
const EXTRA_PARAMS = [PARAM.NUM_SOCKETS, PARAM.LICENSES, PARAM.VOLTAGE_L1, PARAM.UPTIME];

/** Everything the probe collects, ready to print. */
interface ProbeResult {
  host: string;
  info: ChargerDeviceInfo;
  state: ChargerState;
  derived: {
    chargingEnabled: boolean | null;
    drawingPower: boolean;
    vehicleConnected: boolean;
    mode3: string;
    mainState: string;
    socketState: string;
  };
  extras: {
    sockets: number | null;
    voltageL1: number | null;
    uptime: number | null;
    licenseMask: number | null;
    licenses: string[];
  };
  certificateFingerprint: string | null;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const log = makeLogger(args.debug);

  const transport = new NodeHttpsTransport({
    host: args.host,
    port: args.port,
    timeoutMs: args.timeoutMs,
    onFingerprint: (fingerprint) => log.info(`Certificate SHA-256: ${fingerprint}`),
  });

  // Wrap the transport so --debug shows the exact traffic, with the password
  // redacted: the login body is the only place it ever appears.
  const loggingTransport = {
    send: async (request: Parameters<typeof transport.send>[0]) => {
      log.debug(`-> ${request.method} ${request.path}${request.body ? ` ${redact(request.body)}` : ''}`);
      const response = await transport.send(request);
      log.debug(`<- ${response.statusCode} ${truncate(response.body, 500)}`);
      return response;
    },
    closeConnections: () => transport.closeConnections(),
  };

  const backend = new AlfenHttpBackend({
    host: args.host,
    port: args.port,
    username: args.username,
    password: args.password,
    timeoutMs: args.timeoutMs,
    displayName: 'alfen-probe',
    logger: log,
    transport: loggingTransport,
  });

  try {
    log.info(`Reading /api/info from ${args.host} (no login needed)...`);
    const info = await backend.getDeviceInfo();

    log.info(`Logging in as ${args.username}...`);
    await backend.connect();
    log.info('Login succeeded.');

    log.info('Reading parameters...');
    const state = await backend.readState();

    // Read the extras directly so the probe covers a few things the plugin
    // does not poll, such as the licence bitmask that Modbus would need.
    const extras = await readExtras(loggingTransport, EXTRA_PARAMS);

    const licenseMask = toNumber(extras.get(PARAM.LICENSES));
    const result: ProbeResult = {
      host: args.host,
      info,
      state,
      derived: {
        chargingEnabled: isChargingEnabled(state),
        drawingPower: isDrawingPower(state),
        vehicleConnected: isVehicleConnected(state),
        mode3: describeMode3(state.mode3State),
        mainState: describeMainState(state.mainState),
        socketState: describePowerState(state.socketState),
      },
      extras: {
        sockets: toNumber(extras.get(PARAM.NUM_SOCKETS)),
        voltageL1: toNumber(extras.get(PARAM.VOLTAGE_L1)),
        uptime: toNumber(extras.get(PARAM.UPTIME)),
        licenseMask,
        licenses: licenseMask === null ? [] : decodeLicenses(licenseMask),
      },
      certificateFingerprint: transport.fingerprint ?? null,
    };

    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${format(result)}\n`);
    }
    return 0;
  } catch (err) {
    log.error((err as Error).message);
    if (args.debug && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    return 1;
  } finally {
    log.info('Logging out...');
    try {
      await backend.disconnect();
      log.info('Logged out. The Eve Connect app can connect again.');
    } catch (err) {
      log.warn(`Logout failed: ${(err as Error).message}`);
    }
    transport.closeConnections();
  }
}

async function readExtras(
  transport: { send: (r: { method: 'GET'; path: string }) => Promise<{ body: string }> },
  ids: readonly string[],
): Promise<Map<string, unknown>> {
  const response = await transport.send({
    method: 'GET',
    path: `/api/prop?ids=${encodeURIComponent(ids.join(','))}`,
  });
  return extractProperties(parseAlfenJson(response.body));
}

function format(result: ProbeResult): string {
  const { info, state, derived, extras } = result;
  const lines = [
    '',
    '  Charger',
    `    Identity          ${info.identity}`,
    `    Model             ${info.model}`,
    `    Firmware          ${info.firmwareVersion}`,
    `    Sockets           ${extras.sockets ?? 'n/a'}`,
    `    Licenses          ${extras.licenses.length > 0 ? extras.licenses.join(', ') : 'none'}`,
    '',
    '  Current limit',
    `    ${PARAM.NORMAL_MAX_CURRENT} normal max   ${fmt(state.maxCurrentA, 'A')}   <- the plugin writes this`,
    `    ${PARAM.ACTIVE_MAX_CURRENT} active max   ${fmt(state.activeMaxCurrentA, 'A')}`,
    '',
    '  Status',
    `    ${PARAM.MAIN_STATE} main state   ${derived.mainState}`,
    `    ${PARAM.SOCKET_STATE} socket state ${derived.socketState}`,
    `    ${PARAM.MODE3_STATE} mode 3       ${derived.mode3}`,
    '',
    '  Power',
    `    ${PARAM.REAL_POWER_SUM} real power   ${fmt(state.realPowerW, 'W')}`,
    `    ${PARAM.CURRENT_L1} current L1   ${fmt(state.currentsA.l1, 'A')}`,
    `    ${PARAM.CURRENT_L2} current L2   ${fmt(state.currentsA.l2, 'A')}`,
    `    ${PARAM.CURRENT_L3} current L3   ${fmt(state.currentsA.l3, 'A')}`,
    `    ${PARAM.VOLTAGE_L1} voltage L1   ${fmt(extras.voltageL1, 'V')}`,
    '',
    '  Interpretation',
    `    Charging allowed  ${describeBool(derived.chargingEnabled)}  (limit >= ${MIN_CHARGE_CURRENT_A}A)`,
    `    Vehicle connected ${describeBool(derived.vehicleConnected)}`,
    `    Drawing power     ${describeBool(derived.drawingPower)}`,
    '',
    '  Certificate',
    `    SHA-256           ${result.certificateFingerprint ?? 'n/a'}`,
    '',
  ];
  return lines.join('\n');
}


function fmt(value: number | null, unit: string): string {
  if (value === null) {
    return 'n/a'.padStart(8);
  }
  return `${Math.round(value * 100) / 100}${unit}`.padStart(8);
}

function describeBool(value: boolean | null): string {
  if (value === null) {
    return 'unknown';
  }
  return value ? 'yes' : 'no';
}

/** Never let the password reach the console, even with --debug. */
function redact(body: string): string {
  return body.replace(/("password"\s*:\s*)"(?:[^"\\]|\\.)*"/g, '$1"***"');
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

void main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`Unexpected failure: ${(err as Error).message}\n`);
    process.exitCode = 1;
  },
);
