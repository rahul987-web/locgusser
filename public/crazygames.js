(() => {
  const getSdk = () => {
    if (window.CrazyGames?.SDK) {
      return window.CrazyGames.SDK;
    }

    if (window.CrazyGames?.CrazySDK?.getInstance) {
      return window.CrazyGames.CrazySDK.getInstance();
    }

    return null;
  };

  const findMethod = (sdk, paths) => {
    for (const path of paths) {
      let target = sdk;

      for (const key of path.slice(0, -1)) {
        target = target?.[key];
      }

      const methodName = path[path.length - 1];

      if (target && typeof target[methodName] === "function") {
        return () => target[methodName]();
      }
    }

    return null;
  };

  const call = async (paths) => {
    const sdk = getSdk();

    if (!sdk) {
      return false;
    }

    const method = findMethod(sdk, paths);

    if (!method) {
      return false;
    }

    await method();
    return true;
  };

  window.LocGusserCrazyGames = {
    enabled: () => Boolean(getSdk()),
    init: () => call([["init"]]),
    loadingStart: () => call([["game", "loadingStart"], ["loadingStart"]]),
    loadingStop: () => call([["game", "loadingStop"], ["loadingStop"]]),
    gameplayStart: () => call([["game", "gameplayStart"], ["gameplayStart"]]),
    gameplayStop: () => call([["game", "gameplayStop"], ["gameplayStop"]]),
    happytime: () => call([["game", "happytime"], ["happytime"]])
  };
})();
