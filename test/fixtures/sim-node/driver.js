import * as uc from "@unfoldedcircle/integration-api";
const api = new uc.IntegrationAPI();
const sw = new uc.Switch("sim_switch", { en: "Sim switch" }, {
  features: [uc.SwitchFeatures.OnOff, uc.SwitchFeatures.Toggle],
  attributes: { state: uc.SwitchStates.Off },
  cmdHandler: async (e, cmd) => {
    const next = cmd === "on" ? "ON" : cmd === "off" ? "OFF" : sw.attributes.state === "ON" ? "OFF" : "ON";
    // SIM_IMAGE_URL (tests): send a picture link with each change, like a media integration
    const extra = process.env.SIM_IMAGE_URL ? { media_image_url: process.env.SIM_IMAGE_URL } : {};
    if (!api.updateEntityAttributes(sw.id, { state: next, ...extra })) sw.attributes.state = next;
    return uc.StatusCodes.Ok;
  }
});
api.addAvailableEntity(sw);
api.on(uc.Events.Connect, async () => api.setDeviceState(uc.DeviceStates.Connected));
api.init(new URL("./driver.json", import.meta.url).pathname, async () => new uc.SetupComplete());
console.log("sim node driver up on", process.env.UC_INTEGRATION_HTTP_PORT);
