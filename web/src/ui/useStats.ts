import { useAsync } from "@aomc-server/block-ui/hooks";
import { attempt, type Res, type Success } from "../api";

/** Loads statistics whenever `deps` change; the previous result stays until the next arrives. */
export function useStats<R extends Res>(
	call: () => Promise<R>,
	deps: readonly unknown[],
) {
	return useAsync(async (): Promise<Success<R>> => {
		const r = await attempt(call);
		if (!r.ok) throw new Error(r.error);
		return r.body;
	}, deps);
}
