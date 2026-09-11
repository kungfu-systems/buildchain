import { runAdopterDeliveryCli } from "./delivery.mjs";

export async function handleAdopterDeliveryCommand(args) {
  await runAdopterDeliveryCli(args);
}
