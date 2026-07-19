import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { locatePiPackages, packageEntry } from "../../scripts/lib/pi-installation.js";

const packages = locatePiPackages();
register(new URL("./pi-loader-hooks.js", import.meta.url), {
  parentURL: import.meta.url,
  data: {
    modules: {
      "@earendil-works/pi-coding-agent": pathToFileURL(packageEntry(packages.codingAgent, "import")).href,
      "@earendil-works/pi-ai": pathToFileURL(packageEntry(packages.piAi, "import")).href,
      typebox: pathToFileURL(packageEntry(packages.typebox, "import")).href,
    },
  },
});
