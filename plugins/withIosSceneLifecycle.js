const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const launchBlock = /#if os\(iOS\) \|\| os\(tvOS\)\r?\n[ \t]*window = UIWindow\(frame: UIScreen.main.bounds\)\r?\n[ \t]*factory.startReactNative\([\s\S]*?launchOptions: launchOptions\)\r?\n#endif/;
const windowDeclaration = "  var window: UIWindow?";
const linkingMethods = "  // Linking API";
const sceneDelegateName = "AcLogFitSceneDelegate";

const connectScene = `  func connectScene(_ scene: UIWindowScene) {
    guard !sceneRootStarted, let factory = reactNativeFactory else { return }
    sceneRootStarted = true
    let sceneWindow = UIWindow(windowScene: scene)
    window = sceneWindow
    factory.startReactNative(withModuleName: "main", in: sceneWindow, launchOptions: sceneLaunchOptions)
    sceneWindow.makeKeyAndVisible()
  }`;
const sceneDelegate = `@objc(AcLogFitSceneDelegate)
final class AcLogFitSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private var app: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene, let app = app else { return }
    // Preserve cold-start link information before the React root is created.
    var launch = app.sceneLaunchOptions ?? [:]
    if let context = connectionOptions.urlContexts.first {
      launch[.url] = context.url
      if let source = context.options.sourceApplication { launch[.sourceApplication] = source }
    }
    if let activity = connectionOptions.userActivities.first {
      launch[.userActivityDictionary] = ["UIApplicationLaunchOptionsUserActivityKey": activity]
    }
    app.sceneLaunchOptions = launch
    app.connectScene(windowScene)
    window = app.window
  }

  // Expo SDK54 subscribers still consume application delegate callbacks.
  func sceneDidBecomeActive(_ scene: UIScene) { app?.applicationDidBecomeActive(UIApplication.shared) }
  func sceneWillResignActive(_ scene: UIScene) { app?.applicationWillResignActive(UIApplication.shared) }
  func sceneDidEnterBackground(_ scene: UIScene) { app?.applicationDidEnterBackground(UIApplication.shared) }
  func sceneWillEnterForeground(_ scene: UIScene) { app?.applicationWillEnterForeground(UIApplication.shared) }
  func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      if let source = context.options.sourceApplication { options[.sourceApplication] = source }
      if let annotation = context.options.annotation { options[.annotation] = annotation }
      _ = app?.application(UIApplication.shared, open: context.url, options: options)
    }
  }
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    _ = app?.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}`;

function applySceneLifecycle(source) {
    if (source.includes(`@objc(${sceneDelegateName})`)) return source;

    if (!launchBlock.test(source) || !source.includes(windowDeclaration) || !source.includes(linkingMethods)) {
        throw new Error("withIosSceneLifecycle: the Expo AppDelegate template has changed.");
    }

    return source
        .replace(windowDeclaration, `${windowDeclaration}
  var sceneLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?
  private var sceneRootStarted = false`)
        .replace(launchBlock, "    sceneLaunchOptions = launchOptions")
        .replace(linkingMethods, `${connectScene}\n${linkingMethods}`)
        .trimEnd() + `\n\n${sceneDelegate}\n`;
}

module.exports = function withIosSceneLifecycle(config) {
    config = withInfoPlist(config, (mod) => {
        mod.modResults.UIApplicationSceneManifest = {
            UIApplicationSupportsMultipleScenes: false,
            UISceneConfigurations: {
                UIWindowSceneSessionRoleApplication: [{
                    UISceneConfigurationName: "Default Configuration",
                    UISceneDelegateClassName: sceneDelegateName,
                }],
            },
        };
        return mod;
    });

    return withAppDelegate(config, (mod) => {
        if (mod.modResults.language !== "swift") {
            throw new Error("withIosSceneLifecycle: expected a Swift AppDelegate.");
        }
        mod.modResults.contents = applySceneLifecycle(mod.modResults.contents);
        return mod;
    });
};
