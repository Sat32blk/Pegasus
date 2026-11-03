import asyncio, logging, os
import ucapi
logging.basicConfig(level=logging.INFO)
loop = asyncio.new_event_loop()
api = ucapi.IntegrationAPI(loop)

async def cmd(entity, cmd_id, params=None):
    return ucapi.StatusCodes.OK

btn = ucapi.Button("sim_button", "Sim button", cmd_handler=cmd)
api.available_entities.add(btn)

@api.listens_to(ucapi.Events.CONNECT)
async def on_connect():
    await api.set_device_state(ucapi.DeviceStates.CONNECTED)

async def setup(msg):
    return ucapi.SetupComplete()

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    loop.run_until_complete(api.init(os.path.join(here, "..", "driver.json"), setup))
    print("sim python driver up", flush=True)
    loop.run_forever()
