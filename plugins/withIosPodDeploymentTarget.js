const { withPodfile } = require("expo/config-plugins");
const { mergeContents } = require("@expo/config-plugins/build/utils/generateCode");

// Pods may declare an older minimum than the app, which newer Xcode rejects.
// Never lower a dependency's own higher minimum or change the app's minimum.
module.exports = function withIosPodDeploymentTarget(config) {
    return withPodfile(config, (mod) => {
        mod.modResults.contents = mergeContents({
            tag: "aclog-pod-deployment-target",
            src: mod.modResults.contents,
            anchor: /^\s+:ccache_enabled => /,
            offset: 2,
            comment: "#",
            newSrc: `    minimum_target = Gem::Version.new(podfile_properties['ios.deploymentTarget'] || '15.1')
    installer.pods_project.targets.each do |pod_target|
      pod_target.build_configurations.each do |build_configuration|
        current_target = build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET']
        if current_target && current_target.match?(/\\A\\d+(\\.\\d+)*\\z/) && Gem::Version.new(current_target) < minimum_target
          build_configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = minimum_target.to_s
        end
      end
    end`,
        }).contents;
        return mod;
    });
};
