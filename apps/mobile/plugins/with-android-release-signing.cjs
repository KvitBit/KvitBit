// Expo config plugin: configures Android Gradle release signing from
// environment variables (ANDROID_KEYSTORE_PATH / ANDROID_KEYSTORE_PASSWORD /
// ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD) or Gradle properties
// (KVITBIT_UPLOAD_STORE_FILE / ...), instead of falling back to debug signing.
const { withAppBuildGradle } = require("expo/config-plugins");

const RELEASE_SIGNING_MARKER = "// kvitbit-release-signing";

const RELEASE_SIGNING_CONFIG = `
        release {
            ${RELEASE_SIGNING_MARKER}
            def storePath = System.getenv("ANDROID_KEYSTORE_PATH") ?: findProperty("KVITBIT_UPLOAD_STORE_FILE")
            def storePass = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: findProperty("KVITBIT_UPLOAD_STORE_PASSWORD")
            def keyAliasVal = System.getenv("ANDROID_KEY_ALIAS") ?: findProperty("KVITBIT_UPLOAD_KEY_ALIAS")
            def keyPass = System.getenv("ANDROID_KEY_PASSWORD") ?: findProperty("KVITBIT_UPLOAD_KEY_PASSWORD") ?: storePass
            if (storePath && storePass && keyAliasVal) {
                storeFile file(storePath)
                storePassword storePass
                keyAlias keyAliasVal
                keyPassword keyPass
            }
        }`;

const RELEASE_BUILD_TYPE_SIGNING = `            ${RELEASE_SIGNING_MARKER}-build-type
            def hasReleaseSigning = signingConfigs.release.storeFile != null
            if (System.getenv("KVITBIT_REQUIRE_RELEASE_SIGNING") == "true" && !hasReleaseSigning) {
                throw new GradleException("Release build requires ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, and ANDROID_KEY_ALIAS.")
            }
            signingConfig signingConfigs.release`;

/**
 * Pure transformer exported for unit testing.
 * @param {string} contents
 * @returns {string}
 */
function applyAndroidReleaseSigning(contents) {
  let updated = contents;

  if (!updated.includes(RELEASE_SIGNING_MARKER)) {
    const signingConfigsPattern = /(signingConfigs\s*\{[\s\S]*?debug\s*\{[\s\S]*?\})/;
    if (!signingConfigsPattern.test(updated)) {
      throw new Error(
        "with-android-release-signing: could not find signingConfigs.debug block in android/app/build.gradle.",
      );
    }
    updated = updated.replace(signingConfigsPattern, `$1${RELEASE_SIGNING_CONFIG}`);
  }

  if (!updated.includes(`${RELEASE_SIGNING_MARKER}-build-type`)) {
    const releaseBuildTypePattern =
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;
    if (!releaseBuildTypePattern.test(updated)) {
      throw new Error(
        "with-android-release-signing: could not find buildTypes.release signingConfig in android/app/build.gradle.",
      );
    }
    updated = updated.replace(releaseBuildTypePattern, `$1${RELEASE_BUILD_TYPE_SIGNING}`);
  }

  return updated;
}

const withAndroidReleaseSigning = (config) =>
  withAppBuildGradle(config, (mod) => {
    if (mod.modResults.language !== "groovy") {
      throw new Error(
        `with-android-release-signing only supports Groovy build.gradle, got ${mod.modResults.language}.`,
      );
    }
    mod.modResults.contents = applyAndroidReleaseSigning(mod.modResults.contents);
    return mod;
  });

module.exports = withAndroidReleaseSigning;
module.exports.applyAndroidReleaseSigning = applyAndroidReleaseSigning;
