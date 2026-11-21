import {
	createEventStream,
	type Subscription as StreamSubscription,
} from "@aomc-server/block-ui/events";
import type { DataOf, Events, Topic } from "../../server/src/events";

export type { DataOf, Topic };

export type Subscription<T extends Topic> = StreamSubscription<Events, T>;

/** The stream the app shares: `GET /api/events`, with the server's events. */
export const events = createEventStream<Events>();

/** Follows a topic on the shared stream. Returns a function that stops following it. */
export const subscribe = <T extends Topic>(topic: T, sub: Subscription<T>) =>
	events.subscribe(topic, sub);
