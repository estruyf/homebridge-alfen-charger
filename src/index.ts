import type { API } from 'homebridge';

import { AlfenChargerPlatform } from './platform';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

export default (api: API): void => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, AlfenChargerPlatform);
};
