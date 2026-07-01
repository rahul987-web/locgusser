(() => {
  const isEnabled = () => Boolean(window.LOCGUSSER_CRAZYGAMES);

  const getSdk = () => {
    if (!isEnabled()) {
      return null;
    }

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
        return (...args) => target[methodName](...args);
      }
    }

    return null;
  };

  const call = (paths, ...args) => {
    const sdk = getSdk();

    if (!sdk) {
      return false;
    }

    const method = findMethod(sdk, paths);

    if (!method) {
      return false;
    }

    return method(...args);
  };

  window.LocGusserCrazyGames = {
    enabled: () => isEnabled() && Boolean(getSdk()),
    init: () => call([["init"]]),
    loadingStart: () => call([["game", "loadingStart"], ["loadingStart"]]),
    loadingStop: () => call([["game", "loadingStop"], ["loadingStop"]]),
    gameplayStart: () => call([["game", "gameplayStart"], ["gameplayStart"]]),
    gameplayStop: () => call([["game", "gameplayStop"], ["gameplayStop"]]),
    happytime: () => call([["game", "happytime"], ["happytime"]]),
    inviteLink: (params) => call([["game", "inviteLink"], ["inviteLink"]], params),
    showInviteButton: (params) => call([["game", "showInviteButton"], ["showInviteButton"]], params),
    hideInviteButton: () => call([["game", "hideInviteButton"], ["hideInviteButton"]]),
    getInviteParam: (name) => call([["game", "getInviteParam"], ["getInviteParam"]], name),
    addJoinRoomListener: (listener) => call([["game", "addJoinRoomListener"], ["addJoinRoomListener"]], listener),
    updateRoom: (options) => call([["game", "updateRoom"], ["updateRoom"]], options),
    leftRoom: () => call([["game", "leftRoom"], ["leftRoom"]]),
    isInstantMultiplayer: () => Boolean(getSdk()?.game?.isInstantMultiplayer || getSdk()?.isInstantMultiplayer),
    isChatDisabled: () => Boolean(getSdk()?.game?.settings?.disableChat || getSdk()?.settings?.disableChat)
  };
})();
