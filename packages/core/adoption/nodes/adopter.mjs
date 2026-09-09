import {runOperation} from '../../runtime/action-process.mjs';
import {adopterSelection,admitAdopter,runAdopterConformance,reconcileAdopter} from './qualification.mjs';
await runOperation({select:adopterSelection,admit:admitAdopter,conformance:runAdopterConformance,reconcile:reconcileAdopter});
