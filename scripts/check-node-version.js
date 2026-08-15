const minimumMajorVersion = 22;
const currentMajorVersion = Number(process.versions.node.split(".")[0]);

if (currentMajorVersion < minimumMajorVersion) {
  console.error(`
Meal Manager requires Node.js ${minimumMajorVersion} or newer.
Current runtime: ${process.version} (${process.execPath})

Switch to the version pinned by this repository, then reinstall dependencies:

  nvm install
  nvm use
  npm ci
`);
  process.exit(1);
}
