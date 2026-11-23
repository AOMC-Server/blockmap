import type { ComponentChildren } from "preact";
import { currentMap, user } from "../state";
import { Page, usePageLoad } from "./Page";

/** When the statement last changed in substance; update it with the text. */
const UPDATED = "23 November 2026";

/** A contact that looks like an e-mail address or a web address becomes a link. */
function Contact(props: { value: string }) {
	const v = props.value;
	if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
		return <a href={`mailto:${v}`}>{v}</a>;
	if (/^https?:\/\//.test(v))
		return (
			<a href={v} target="_blank" rel="noopener noreferrer">
				{v}
			</a>
		);
	return <>{v}</>;
}

function Section(props: { title: string; children: ComponentChildren }) {
	return (
		<section class="page-section privacy">
			<h2>{props.title}</h2>
			{props.children}
		</section>
	);
}

/** /privacy: what the site keeps about people, why, for how long, and what they can do about it. */
export function PrivacyPage() {
	const { status } = usePageLoad();
	const detail = currentMap.value;
	const controller = detail?.privacy.controller ?? "";
	const contact = detail?.privacy.contact ?? "";
	const site = detail?.map.name ?? "this map";
	const loggedIn = user.value !== null;

	return (
		<Page title="Privacy">
			<Section title="Summary">
				<p>
					{site} is a community Minecraft map. We only store the data needed to
					operate the map and credit contributions. There are no ads, analytics,
					or tracking cookies, and no data is sold or shared for marketing.
					Browsing the map without logging in leaves no personal data on the
					server.
				</p>
				<p class="muted">Last updated {UPDATED}.</p>
			</Section>

			<Section title="Data controller">
				{status === "loading" ? (
					<p class="muted">Loading…</p>
				) : controller || contact ? (
					<p>
						The data controller responsible for personal data on this site under
						the EU General Data Protection Regulation (GDPR) is{" "}
						<b>{controller || "the site operator"}</b>.
						{contact && (
							<>
								{" "}
								For privacy inquiries or data requests, contact{" "}
								<Contact value={contact} />.
							</>
						)}
					</p>
				) : (
					<p>
						Contact details have not been configured yet. Please reach out to a
						map moderator with any privacy questions.
					</p>
				)}
			</Section>

			<Section title="Browsing without logging in">
				<ul>
					<li>
						Your <b>IP address</b> is held briefly in memory for rate limiting
						(such as generating short links and preview images). It is never
						written to disk, and the server does not keep IP access logs.
					</li>
					<li>
						The server records aggregate traffic metrics (request counts and
						bandwidth by category and hour) without any visitor identifiers.
					</li>
					<li>
						Your display preferences, layer visibility choices, and last map
						position are stored locally in <b>your browser</b> (localStorage).
						They are never sent to the server and can be cleared through your
						browser settings.
					</li>
				</ul>
			</Section>

			<Section title="Logging in with Discord">
				<p>
					Authentication is handled via Discord OAuth using only the{" "}
					<code>identify</code> scope. The site never receives your email
					address, Discord servers, or messages. When you log in, we store:
				</p>
				<ul>
					<li>
						your Discord <b>user ID</b>, <b>display name</b>, and <b>avatar</b>{" "}
						URL (updated on each login);
					</li>
					<li>your account creation and last login timestamps;</li>
					<li>
						your map <b>role</b> (if granted moderator or owner access), private
						layer memberships, and file library folder permissions.
					</li>
				</ul>
				<p>
					Two strictly necessary cookies are used for authentication: a 30-day{" "}
					<b>session cookie</b> renewed as you use the site (stored only as a
					hash on the server), and a short-lived OAuth state cookie used during
					login to prevent cross-site request forgery. Because both are strictly
					necessary to provide login functionality, they do not require consent
					under the Swedish Electronic Communications Act (lagen om elektronisk
					kommunikation). No other cookies are used.
				</p>
			</Section>

			<Section title="Your contributions">
				<p>
					Content you contribute is associated with your account and displays
					your username:
				</p>
				<ul>
					<li>
						<b>Uploads</b>: map tiles, coordinates, file counts, export
						timestamps, and whether the upload was sent via the in-game mod.
					</li>
					<li>
						<b>Layers and features</b> (pins, lines, and areas), including full
						revision history and deleted versions so edits can be reviewed or
						restored.
					</li>
					<li>
						<b>File library items</b>: files and folders you upload or create,
						along with their names, sizes, timestamps, and your username
						(visible to logged-in users).
					</li>
					<li>
						<b>Invites</b>, <b>short links</b>, and <b>API tokens</b> (name,
						scopes, and last-used timestamp; token secrets are stored only as
						hashes).
					</li>
				</ul>
				<p>
					Because the map is public, your username appears publicly alongside
					your uploads, feature edit history, and leaderboard statistics.
					Private layers are only visible to invited members and map moderators.
				</p>
			</Section>

			<Section title="Purpose and legal basis">
				<ul>
					<li>
						Account and contribution data are processed to provide the service,
						allowing you to log in, upload map exports, and edit shared layers
						(GDPR Article 6(1)(b), performance of a contract).
					</li>
					<li>
						Attribution, revision history, rate limiting, and aggregate traffic
						statistics are maintained to prevent abuse and keep the map reliable
						(GDPR Article 6(1)(f), legitimate interests). You have the right to
						object to this processing; see below.
					</li>
				</ul>
				<p>We do not use automated decision-making or user profiling.</p>
			</Section>

			<Section title="Third parties and hosting">
				<ul>
					<li>
						<b>Discord</b> handles sign-in under its own{" "}
						<a
							href="https://discord.com/privacy"
							target="_blank"
							rel="noopener noreferrer"
						>
							privacy policy
						</a>
						. User avatars are loaded directly from Discord's CDN, which means
						Discord receives your IP address when avatars are displayed. Discord
						is based in the United States.
					</li>
					<li>
						This site is <b>hosted in the EU/EEA</b>. The hosting provider
						processes data solely on behalf of the operator.
					</li>
				</ul>
				<p>No personal data is shared with any other third parties.</p>
			</Section>

			<Section title="Data retention">
				<ul>
					<li>
						<b>Account data</b> is kept until you delete your account. Browser
						sessions expire after 30 days of inactivity or when you log out.
					</li>
					<li>
						<b>Contributions</b> remain part of the shared map even if you
						delete your account, reassigned to an anonymised “Deleted user”
						entry with no link back to your Discord identity. You can delete
						your own features at any time and your own map uploads within the
						self-delete window; contact a moderator or the controller above to
						request removal of older contributions.
					</li>
					<li>
						<b>Backups</b> may retain deleted records briefly until rotated out
						by newer snapshots.
					</li>
				</ul>
			</Section>

			<Section title="Your rights">
				<p>
					Under the GDPR, you have the right to access, rectify, erase, or
					export your personal data, as well as the right to restrict or object
					to its processing.{" "}
					{loggedIn ? (
						<>
							You can download a JSON archive of your data or delete your
							account directly in <a href="/settings#your-data">Settings</a>.
						</>
					) : (
						<>
							Once logged in, you can download your data or delete your account
							directly from Settings.
						</>
					)}{" "}
					Your display name and avatar sync automatically from Discord whenever
					you log in. For any other requests, use the contact details above.
				</p>
				<p>
					If you believe your personal data has been handled improperly, you
					have the right to lodge a complaint with the Swedish Authority for
					Privacy Protection,{" "}
					<a
						href="https://www.imy.se/"
						target="_blank"
						rel="noopener noreferrer"
					>
						Integritetsskyddsmyndigheten (IMY)
					</a>
					, or your local supervisory authority.
				</p>
			</Section>
		</Page>
	);
}
