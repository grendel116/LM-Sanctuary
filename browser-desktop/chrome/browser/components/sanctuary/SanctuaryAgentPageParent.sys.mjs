/* SPDX-License-Identifier: AGPL-3.0-or-later */

const ACTOR_NAME = "SanctuaryAgentPage";

function getTopActor(browser) {
  const wg = browser?.browsingContext?.currentWindowGlobal;
  if (!wg || typeof wg.getActor !== "function") {
    return null;
  }
  return wg.getActor(ACTOR_NAME);
}

/**
 * Parent-process JSWindowActor for Sanctuary Browser agent page inspection and interaction.
 */
export class SanctuaryAgentPageParent extends JSWindowActorParent {
  async challenge() {
    return this.sendQuery("SanctuaryAgentPage:Challenge", {});
  }

  async snapshot(opts = {}) {
    return this.sendQuery("SanctuaryAgentPage:Snapshot", opts);
  }

  async text(opts = {}) {
    return this.sendQuery("SanctuaryAgentPage:Text", opts);
  }

  async click(opts = {}) {
    return this.sendQuery("SanctuaryAgentPage:Click", opts);
  }

  async type(opts = {}) {
    return this.sendQuery("SanctuaryAgentPage:Type", opts);
  }

  async select(opts = {}) {
    return this.sendQuery("SanctuaryAgentPage:Select", opts);
  }

  async press(opts = {}) {
    return this.sendQuery("SanctuaryAgentPage:Press", opts);
  }

  async scroll(opts = {}) {
    return this.sendQuery("SanctuaryAgentPage:Scroll", opts);
  }

  async waitForText(opts = {}) {
    return this.sendQuery("SanctuaryAgentPage:WaitForText", opts);
  }
}

export function pageActor(browser) {
  const actor = getTopActor(browser);
  if (!actor) {
    throw Object.assign(new Error("SanctuaryAgentPage actor is not available for browser tab."), {
      code: "actor_unavailable",
    });
  }
  return actor;
}
