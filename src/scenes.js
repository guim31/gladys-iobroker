// -----------------------------------------------------------------------------
// Scene actions (manifest `scene_actions`): write a value to any ioBroker
// state (a script trigger in 0_userdata, a scene of the scenes adapter, a
// state not added to Gladys). The state id is typed by the scene author: the
// scene editor can only list Gladys devices.
//
// The states of locks, gates, garage doors and alarms follow the same switch
// as the devices (allow_security_commands): a scene is not a way around it.
// -----------------------------------------------------------------------------

export function sceneActions(bridge) {
  return {
    async set_state(fields) {
      await bridge.setStateFromScene(fields.state, fields.value);
    },
  };
}

export const SCENE_ACTION_KEYS = ['set_state'];
