// Kilo Status: Kilo Code terminals report their status to Herdr.
//
// The work is done by herdr-agent-state.ts, a Kilo server plugin that
// status.mjs installs into Kilo's own plugin folder, so it works while this
// mod, and the app, are closed. This file only makes the folder a valid Herdr
// mod; it shows nothing.

import { View, div } from "gpui-kit";

export default class KiloStatus extends View {
  render(cx) {
    return div().id("kilo-status");
  }
}
