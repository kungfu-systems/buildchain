import { bindPromotionInvocation } from "../promotion-request.js";

export async function admitPromotionInvocation({ request, selection }) {
  return { "invocation-json": JSON.stringify(bindPromotionInvocation(request, selection)) };
}
