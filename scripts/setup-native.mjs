// Creates the iOS and Android projects with your own app ID, icon and splash screen.
//   npm run setup:native -- com.yourname.safetospend
// Safe to run again: it deletes and rebuilds ios/ and android/.
import fs from "node:fs";
import { execSync } from "node:child_process";

const appId = process.argv[2];
if(!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(appId || "")){
  console.error("Give an app ID in reverse-domain form, all lowercase, for example:\n  npm run setup:native -- com.yourname.safetospend");
  process.exit(1);
}
const cfgPath = "capacitor.config.json";
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
cfg.appId = appId;
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
console.log("App ID set to " + appId);

for(const dir of ["ios", "android"]) fs.rmSync(dir, { recursive: true, force: true });
const run = cmd => { console.log("\n$ " + cmd); execSync(cmd, { stdio: "inherit" }); };
run("npx cap add android");
run("npx cap add ios --packagemanager SPM");
run("npx capacitor-assets generate --iconBackgroundColor '#0B5D75' --iconBackgroundColorDark '#0B5D75' --splashBackgroundColor '#0B5D75' --splashBackgroundColorDark '#0E1519'");
run("npx cap sync");
console.log("\nDone. Open the projects with:  npx cap open ios   or   npx cap open android");
