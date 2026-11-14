// Freebuff Status: Freebuff terminals report their status to Herdr.
//
// The work is done by freebuff-watcher.mjs, which `status.mjs install` wires
// into a `freebuff` wrapper in ~/.local/bin. The wrapper starts the watcher
// inside a Herdr terminal and then execs the real binary, so it works while
// this mod, and the app, are closed. This file only makes the folder a valid
// Herdr mod; it shows nothing and launches nothing.

import { View, div } from "gpui-kit";

export default class FreebuffStatus extends View {
  render(cx) {
    return div().id("freebuff-status");
  }
}
