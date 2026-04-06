const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	SlashCommandBuilder,
} = require("discord.js");

const PAGE_SIZE = 20;
const PAGINATION_CUSTOM_ID_PREFIX = "ticketshow_page";
const PAGE_INDICATOR_CUSTOM_ID_PREFIX = "ticketshow_page_indicator";

const data = new SlashCommandBuilder()
	.setName("ticketshow")
	.setDescription("Show closed tickets for a user")
	.addStringOption((option) =>
		option
			.setName("user")
			.setDescription("Mention a user or provide their user ID")
			.setRequired(true)
	);

function parseUserIdFromInput(userInput) {
	const value = String(userInput).trim();
	// Accept either a mention or a raw user ID so staff can paste whichever they have.
	const mentionMatch = value.match(/^<@!?(\d+)>$/);

	if (mentionMatch) {
		return mentionMatch[1];
	}

	if (/^\d{17,20}$/.test(value)) {
		return value;
	}

	return null;
}

function buildPageButtonCustomId(targetUserId, page, requesterUserId) {
	return `${PAGINATION_CUSTOM_ID_PREFIX}:${targetUserId}:${page}:${requesterUserId}`;
}

function parsePageButtonCustomId(customId) {
	const parts = String(customId).split(":");
	// Validate every segment; button custom IDs can be edited client-side.
	if (parts.length !== 4 || parts[0] !== PAGINATION_CUSTOM_ID_PREFIX) {
		return null;
	}

	const [, targetUserId, pageText, requesterUserId] = parts;

	if (!/^\d{17,20}$/.test(targetUserId)) {
		return null;
	}

	if (!/^\d+$/.test(pageText)) {
		return null;
	}

	if (!/^\d{17,20}$/.test(requesterUserId)) {
		return null;
	}

	return {
		targetUserId,
		page: Number.parseInt(pageText, 10),
		requesterUserId,
	};
}

function isPaginationButtonCustomId(customId) {
	return String(customId).startsWith(`${PAGINATION_CUSTOM_ID_PREFIX}:`);
}

async function getClosedTicketsPage(dbGet, dbAll, discordUserId, requestedPage) {
	const countRow = await dbGet(
		`
			SELECT COUNT(*) AS count
			FROM closed_tickets
			WHERE discord_user_id = ?
		`,
		[discordUserId]
	);

	const totalTickets = Number(countRow?.count || 0);
	const totalPages = totalTickets > 0 ? Math.ceil(totalTickets / PAGE_SIZE) : 1;
	// Clamp page to avoid invalid offsets when users spam old buttons.
	const safePage = Math.max(0, Math.min(requestedPage, totalPages - 1));

	if (totalTickets === 0) {
		return {
			tickets: [],
			totalTickets,
			totalPages,
			page: safePage,
		};
	}

	const offset = safePage * PAGE_SIZE;
	const tickets = await dbAll(
		`
			SELECT ticket_id, link_to_discord_message
			FROM closed_tickets
			WHERE discord_user_id = ?
			ORDER BY closed_at DESC
			LIMIT ? OFFSET ?
		`,
		[discordUserId, PAGE_SIZE, offset]
	);

	return {
		tickets,
		totalTickets,
		totalPages,
		page: safePage,
	};
}

function buildClosedTicketsEmbed(discordUserId, pageTickets, page, totalPages, totalTickets) {
	const pageStartNumber = page * PAGE_SIZE;
	const lines = pageTickets.map((ticket, index) => {
		const linkValue = ticket.link_to_discord_message
			? `[Open Message](${ticket.link_to_discord_message})`
			: "No message link";

		return `${pageStartNumber + index + 1}. Ticket ID: ${ticket.ticket_id} | ${linkValue}`;
	});

	const description = lines.length > 0 ? lines.join("\n") : "No closed tickets were found for this user.";

	return new EmbedBuilder()
		.setColor(0x2b84ff)
		.setTitle("Closed Tickets")
		.setDescription(description)
		.setFooter({
			text: `Total tickets: ${totalTickets}`,
		});
}

async function resolveUserDisplayName(interaction, discordUserId) {
	if (interaction.inGuild()) {
		try {
			const member = await interaction.guild.members.fetch(discordUserId);
			if (member?.user) {
				return member.user.globalName || member.user.username;
			}
		} catch {
			// Fall through to global user fetch.
		}
	}

	try {
		const user = await interaction.client.users.fetch(discordUserId);
		if (user) {
			return user.globalName || user.username;
		}
	} catch {
		// Ignore and use ID fallback.
	}

	return discordUserId;
}

function buildPaginationRow(targetUserId, page, totalPages, requesterUserId) {
	if (totalPages <= 1) {
		return null;
	}

	const previousButton = new ButtonBuilder()
		.setCustomId(buildPageButtonCustomId(targetUserId, page - 1, requesterUserId))
		.setLabel("Previous")
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(page <= 0);

	const indicatorButton = new ButtonBuilder()
		.setCustomId(
			`${PAGE_INDICATOR_CUSTOM_ID_PREFIX}:${targetUserId}:${page}:${requesterUserId}`
		)
		.setLabel(`Page ${page + 1}/${totalPages}`)
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(true);

	const nextButton = new ButtonBuilder()
		.setCustomId(buildPageButtonCustomId(targetUserId, page + 1, requesterUserId))
		.setLabel("Next")
		.setStyle(ButtonStyle.Secondary)
		.setDisabled(page >= totalPages - 1);

	return new ActionRowBuilder().addComponents(previousButton, indicatorButton, nextButton);
}

async function renderTicketPage(interaction, context, targetUserId, page, mode, requesterUserId) {
	const { dbGet, dbAll } = context;
	const userDisplayName = await resolveUserDisplayName(interaction, targetUserId);
	const { tickets, totalTickets, totalPages, page: safePage } = await getClosedTicketsPage(
		dbGet,
		dbAll,
		targetUserId,
		page
	);

	const embed = buildClosedTicketsEmbed(targetUserId, tickets, safePage, totalPages, totalTickets);
	embed.setTitle(`Closed Tickets for ${userDisplayName}`);
	const paginationRow = buildPaginationRow(targetUserId, safePage, totalPages, requesterUserId);
	const payload = paginationRow ? { embeds: [embed], components: [paginationRow] } : { embeds: [embed], components: [] };

	// Initial slash command uses editReply; pagination buttons must use update.
	if (mode === "edit") {
		await interaction.editReply(payload);
		return;
	}

	if (mode === "update") {
		await interaction.update(payload);
	}
}

async function execute(interaction, context) {
	const { memberHasSupportRole } = context;

	await interaction.deferReply();

	const hasSupportRole = await memberHasSupportRole(interaction);
	if (!hasSupportRole) {
		await interaction.editReply("You don't have permission to use this command.");
		return;
	}

	const userInput = interaction.options.getString("user", true);
	const targetUserId = parseUserIdFromInput(userInput);

	if (!targetUserId) {
		await interaction.editReply(
			"Invalid user value. Use a user mention (for example, <@123...>) or a user ID."
		);
		return;
	}

	await renderTicketPage(interaction, context, targetUserId, 0, "edit", interaction.user.id);
}

async function handlePaginationButton(interaction, context) {
	const { memberHasSupportRole } = context;
	const parsed = parsePageButtonCustomId(interaction.customId);

	if (!parsed) {
		return false;
	}

	const hasSupportRole = await memberHasSupportRole(interaction);
	if (!hasSupportRole) {
		await interaction.reply({
			content: "You don't have permission to use this command.",
		});
		return true;
	}

	if (parsed.requesterUserId !== interaction.user.id) {
		// Keep pagination bound to the original requester to avoid cross-user hijacking.
		await interaction.reply({
			content: "Only the user who ran /ticketshow can use these buttons.",
		});
		return true;
	}

	await renderTicketPage(
		interaction,
		context,
		parsed.targetUserId,
		parsed.page,
		"update",
		parsed.requesterUserId
	);

	return true;
}

module.exports = {
	data,
	execute,
	handlePaginationButton,
	isPaginationButtonCustomId,
};
