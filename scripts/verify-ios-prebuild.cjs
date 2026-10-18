const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const plist = require('@expo/plist').default;

const root = path.resolve(__dirname, '..');
const ios = path.resolve(process.argv[2] || path.join(root, 'ios'));
const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'))).expo;
const projects = fs.readdirSync(ios).filter(name => name.endsWith('.xcodeproj'));
assert.equal(projects.length, 1, 'Select one generated iOS project');
const name = projects[0].replace(/\.xcodeproj$/, '');
const project = fs.readFileSync(path.join(ios, projects[0], 'project.pbxproj'), 'utf8');
const info = plist.parse(fs.readFileSync(path.join(ios, name, 'Info.plist'), 'utf8'));
const properties = JSON.parse(fs.readFileSync(path.join(ios, 'Podfile.properties.json')));
assert.equal(info.CFBundleShortVersionString, config.version);
const updates = plist.parse(fs.readFileSync(path.join(ios, name, 'Supporting/Expo.plist'), 'utf8'));
assert.equal(updates.EXUpdatesRuntimeVersion, config.version);
assert.equal(updates.EXUpdatesURL, config.updates.url);
const delegate = fs.readFileSync(path.join(ios, name, 'AppDelegate.swift'), 'utf8');
assert.ok(delegate.includes('GMSServices.provideAPIKey'), 'Google Maps initialization missing');
for (const mode of ['fetch', 'location']) assert.ok(info.UIBackgroundModes.includes(mode));
for (const key of ['NSLocationWhenInUseUsageDescription', 'NSLocationAlwaysAndWhenInUseUsageDescription'])
    assert.ok(info[key]?.length, `Missing ${key}`);
const teams = [...project.matchAll(/DEVELOPMENT_TEAM = ([^;]+);/g)].map(match => match[1]);
assert.ok(teams.length >= 2);
assert.ok(teams.every(team => team === config.ios.appleTeamId));
const identifiers = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map(match => match[1]);
assert.ok(identifiers.length >= 2 && identifiers.every(id => id === config.ios.bundleIdentifier));
const podfile = fs.readFileSync(path.join(ios, 'Podfile'), 'utf8');
assert.ok(podfile.includes("pod 'react-native-google-maps'"));
assert.equal((podfile.match(/# @generated begin aclog-pod-deployment-target /g) || []).length, 1);
const pods = fs.readFileSync(path.join(ios, 'Pods/Pods.xcodeproj/project.pbxproj'), 'utf8');
const targets = [...pods.matchAll(/IPHONEOS_DEPLOYMENT_TARGET = ([\d.]+);/g)].map(match => match[1]);
assert.ok(targets.length > 0);
function version(value) { return value.split('.').map(Number); }
function atLeast(value, minimum) {
    const left = version(value), right = version(minimum);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const delta = (left[i] || 0) - (right[i] || 0);
        if (delta) return delta > 0;
    }
    return true;
}
assert.ok(targets.every(target => atLeast(target, properties['ios.deploymentTarget'])));
console.log(JSON.stringify({ version: config.version, teamMatches: true, bundleMatches: true,
    runtimeMatches: true, mapsPreserved: true, backgroundLocationPreserved: true, podHookCount: 1, podsChecked: targets.length,
    minimumIos: properties['ios.deploymentTarget'] }, null, 2));
