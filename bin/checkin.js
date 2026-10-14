#!/usr/bin/env node
import("../dist/cli.js").then(
  (m) => m.main(),
  (err) => {
    if (err && err.code === "ERR_MODULE_NOT_FOUND") {
      console.error("checkin: build output missing. Run `npm run build` in the package directory.");
    } else {
      console.error(err);
    }
    process.exit(1);
  },
);
