const { withAndroidManifest } = require("expo/config-plugins");

// Keep portrait layout and network permissions, without making their hardware
// prerequisites mandatory for Google Play installation.
const optionalFeatures = ["android.hardware.screen.portrait", "android.hardware.wifi"];

function applyOptionalFeatures(androidManifest) {
    const manifest = androidManifest.manifest;
    const features = manifest["uses-feature"] || (manifest["uses-feature"] = []);
    for (const name of optionalFeatures) {
        const matches = features.filter(feature => feature.$?.["android:name"] === name);
        if (matches.length) {
            for (const feature of matches) feature.$["android:required"] = "false";
        } else {
            features.push({ $: { "android:name": name, "android:required": "false" } });
        }
    }
    return androidManifest;
}

module.exports = config => withAndroidManifest(config, mod => {
    mod.modResults = applyOptionalFeatures(mod.modResults);
    return mod;
});
module.exports.applyOptionalFeatures = applyOptionalFeatures;
