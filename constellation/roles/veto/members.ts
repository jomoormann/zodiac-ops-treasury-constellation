import { eth } from "../../context";

// The Security Council Safe (1/3): any one council signer can veto
export default [eth.safe["Ops Security Council"]] satisfies Members;
