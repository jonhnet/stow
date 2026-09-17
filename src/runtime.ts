declare const __STOW_DEMO__: boolean;
/** A build-time choice, never a URL flag or a browser storage preference. */
export const IS_DEMO = typeof __STOW_DEMO__ !== 'undefined' && __STOW_DEMO__;
export const INSTALL_URL = 'https://github.com/jonhnet/stow#readme';
export const DEMO_IMAGE_MESSAGE = 'Image uploads are unavailable in the demo. You can open and remove the sample kitten pictures.';
