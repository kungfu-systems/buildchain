import {
  ADOPTER_PROTOCOL_DRIVER_INTERFACE,
  defineAdopterProtocolDriver,
} from "@kungfu-tech/buildchain/adopter-delivery-gate";

import authority from "./authority.json" with { type: "json" };
import { verifyLedgerSpecification } from "./verifier.js";

export const ledgerSpecificationDriver = defineAdopterProtocolDriver({
  interface: ADOPTER_PROTOCOL_DRIVER_INTERFACE,
  id: authority.protocol.id,
  version: authority.protocol.version,
  verify({ request }) {
    return verifyLedgerSpecification(request);
  },
});

export default ledgerSpecificationDriver;
