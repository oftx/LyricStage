/**
 * MAIN-world content-script entry for Apple Music MusicKit lyric requests.
 * Only registered on music.apple.com in the extension manifest.
 */
import { installAppleMusicIdentityHooks } from './identity-hooks.js';
import { installAppleMusicRequestBridge } from './main-request-bridge.js';

installAppleMusicIdentityHooks();
installAppleMusicRequestBridge();