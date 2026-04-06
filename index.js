require("dotenv").config();

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const REQUIRED_ENV_VARS = [
  "DISCORD_TOKEN",
  "TICKET_CATEGORY_ID",
  "TICKET_PANEL_CHANNEL_ID",
  "TRANSCRIPTS_CHANNEL_ID",
];
const missingVars = REQUIRED_ENV_VARS.filter((name) => !process.env[name]);

if (missingVars.length > 0) {
  console.error(`Missing required .env variables: ${missingVars.join(", ")}`);
  process.exit(1);
}

const {
  DISCORD_TOKEN,
  TICKET_CATEGORY_ID,
  SUPPORT_ROLE_ID,
  TICKET_PANEL_CHANNEL_ID,
  TRANSCRIPTS_CHANNEL_ID,
  ONE_OPEN_TICKET_PER_USER,
  DM_TRANSCRIPT_USER_ON_TICKET_CLOSE,
  AUTO_DELETE_TRANSCRIPTS,
  BLACKLIST_USAGE_ALLOWED_ROLEID,
} = process.env;

function parseBooleanEnv(value, defaultValue = true) {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

const oneOpenTicketPerUserEnabled = parseBooleanEnv(ONE_OPEN_TICKET_PER_USER, true);
const dmTranscriptUserOnTicketCloseEnabled = parseBooleanEnv(
  DM_TRANSCRIPT_USER_ON_TICKET_CLOSE,
  false
);
const autoDeleteTranscriptsEnabled = parseBooleanEnv(AUTO_DELETE_TRANSCRIPTS, false);
const supportRoleId = String(SUPPORT_ROLE_ID || "").trim() || null;
let hasLoggedSupportRoleAdminFallback = false;

const DATA_DIRECTORY = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIRECTORY, "data.db");
const LEGACY_DB_PATH = path.join(DATA_DIRECTORY, "tickets.db");
const TRANSCRIPTS_DIRECTORY = path.join(DATA_DIRECTORY, "transcripts");

fs.mkdirSync(DATA_DIRECTORY, { recursive: true });
fs.mkdirSync(TRANSCRIPTS_DIRECTORY, { recursive: true });

function migrateLegacyDatabasePath() {
  // One-time rename for older installs that still use tickets.db.
  if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
    try {
      fs.renameSync(LEGACY_DB_PATH, DB_PATH);
      console.log("Migrated legacy database file from tickets.db to data.db");
    } catch (error) {
      console.warn("Could not migrate legacy database file automatically:", error);
    }
  }
}

migrateLegacyDatabasePath();

const db = new sqlite3.Database(DB_PATH);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(error) {
      if (error) {
        reject(error);
        return;
      }

      resolve(this);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row || null);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows || []);
    });
  });
}

async function ensureClosedTicketsSchema() {
  // Runtime schema check keeps existing databases compatible after new columns are introduced.
  const columns = await dbAll("PRAGMA table_info(closed_tickets)");
  const hasMessageLinkColumn = columns.some(
    (column) => column && column.name === "link_to_discord_message"
  );

  if (!hasMessageLinkColumn) {
    await dbRun("ALTER TABLE closed_tickets ADD COLUMN link_to_discord_message TEXT");
  }
}

async function initializeDatabase() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS open_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL UNIQUE,
      ticket_id TEXT NOT NULL UNIQUE,
      info TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS closed_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      closed_by TEXT NOT NULL,
      info TEXT NOT NULL,
      created_at TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      link_to_discord_message TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS blacklisted (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL,
      blacklisted_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  await ensureClosedTicketsSchema();
}

const CUSTOM_IDS = {
  OPEN_TICKET_BUTTON: "open_support_ticket",
  TICKET_MODAL: "support_ticket_modal",
  REPORT_TARGET: "report_target",
  ISSUE_DESCRIPTION: "issue_description",
  CLOSE_TICKET_BUTTON: "close_ticket",
  CLOSE_TICKET_MODAL: "close_ticket_modal",
  CREATED_REASON: "created_reason",
  CLOSED_REASON: "closed_reason",
};

const ticketShowCommand = require("./commands/ticketshow");
const blacklistCommand = require("./commands/blacklist");

const SLASH_COMMANDS = [ticketShowCommand, blacklistCommand];
const SLASH_COMMANDS_BY_NAME = new Map(
  SLASH_COMMANDS.map((command) => [command.data.name, command])
);

// Lightweight pattern guard for modal text; SQL parameters are still used for DB writes.
const SQL_INJECTION_PATTERN =
  /(--|\/\*|\*\/|;\s*(drop|alter|truncate|insert|delete|update|select|union|create|grant|revoke)\b|\bunion\s+select\b|\bor\s+1\s*=\s*1|\band\s+1\s*=\s*1)/i;

class ValidationError extends Error {}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

function generateTicketCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";

  for (let i = 0; i < 6; i += 1) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return code;
}

async function ticketIdExists(ticketId) {
  const openTicketMatch = await dbGet(
    `
      SELECT ticket_id
      FROM open_tickets
      WHERE ticket_id = ?
      LIMIT 1
    `,
    [ticketId]
  );

  if (openTicketMatch) {
    return true;
  }

  const closedTicketMatch = await dbGet(
    `
      SELECT ticket_id
      FROM closed_tickets
      WHERE ticket_id = ?
      LIMIT 1
    `,
    [ticketId]
  );

  return Boolean(closedTicketMatch);
}

async function generateUniqueTicketCode(maxAttempts = 50) {
  // Hard cap avoids an infinite loop if the ID space gets crowded.
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidateCode = generateTicketCode();
    const exists = await ticketIdExists(candidateCode);

    if (!exists) {
      return candidateCode;
    }
  }

  throw new Error("Could not generate a unique ticket ID. Please try again.");
}

function buildTicketButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.OPEN_TICKET_BUTTON)
      .setLabel("Open Support Ticket")
      .setStyle(ButtonStyle.Primary)
  );
}

function buildCloseTicketButton() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(CUSTOM_IDS.CLOSE_TICKET_BUTTON)
      .setLabel("Close Ticket")
      .setStyle(ButtonStyle.Danger)
  );
}

function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("Need Help?")
    .setDescription("Click the button below to open a support ticket.")
    .setColor(0x2b84ff);
}

function buildTicketModal() {
  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_IDS.TICKET_MODAL)
    .setTitle("Support Ticket Form");

  const reportTargetInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.REPORT_TARGET)
    .setLabel("Reported user username/userID (if report)")
    .setPlaceholder("If this is a report, input the user's username or userID")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100);

  const issueDescriptionInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.ISSUE_DESCRIPTION)
    .setLabel("Describe the issue")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1000);

  modal.addComponents(
    new ActionRowBuilder().addComponents(reportTargetInput),
    new ActionRowBuilder().addComponents(issueDescriptionInput)
  );

  return modal;
}

function buildCloseTicketModal() {
  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_IDS.CLOSE_TICKET_MODAL)
    .setTitle("Close Ticket");

  const createdReasonInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.CREATED_REASON)
    .setLabel("Created reason")
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(250);

  const closedReasonInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.CLOSED_REASON)
    .setLabel("Closed reason")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(1000);

  modal.addComponents(
    new ActionRowBuilder().addComponents(createdReasonInput),
    new ActionRowBuilder().addComponents(closedReasonInput)
  );

  return modal;
}

function sanitizeTicketInput(value) {
  return value
    .replace(/\u0000/g, "")
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .replace(/[^\S\r\n\t]+/g, " ")
    .trim();
}

function validateAndSanitizeInput(value, fieldLabel, isRequired) {
  const sanitized = sanitizeTicketInput(value);

  if (isRequired && sanitized.length === 0) {
    throw new ValidationError(`${fieldLabel} cannot be empty.`);
  }

  if (sanitized.length > 0 && SQL_INJECTION_PATTERN.test(sanitized)) {
    throw new ValidationError(
      `${fieldLabel} contains blocked SQL-like patterns. Please remove them and try again.`
    );
  }

  return sanitized.length > 0 ? sanitized : null;
}

function formatTimestampForFilename(isoTimestamp) {
  return isoTimestamp.replace(/[:.]/g, "-");
}

function formatUtcDateTime(dateInput) {
  const date = new Date(dateInput);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");

  return `${day}-${month}-${year} ${hours}:${minutes}`;
}

async function fetchAllChannelMessages(channel) {
  const allMessages = [];
  let before;

  // Pull messages in batches, then reverse once to get chronological transcript output.
  while (true) {
    const batch = await channel.messages.fetch({
      limit: 100,
      ...(before ? { before } : {}),
    });

    if (batch.size === 0) {
      break;
    }

    allMessages.push(...batch.values());
    before = batch.last().id;

    if (batch.size < 100) {
      break;
    }
  }

  return allMessages.reverse();
}

function formatMessageForTranscript(message) {
  const timestamp = formatUtcDateTime(message.createdTimestamp);
  const authorTag = message.author ? `${message.author.tag} (${message.author.id})` : "Unknown";
  const messageContent = message.content ? message.content.replace(/\r/g, "") : "[no text content]";

  const lines = [`[${timestamp}] ${authorTag}: ${messageContent}`];

  for (const attachment of message.attachments.values()) {
    lines.push(`  Attachment: ${attachment.name || "file"} - ${attachment.url}`);
  }

  for (const embed of message.embeds) {
    const summary = [];

    if (embed.title) {
      summary.push(`title="${embed.title.replace(/\r/g, " ").replace(/\n/g, " ")}"`);
    }

    if (embed.description) {
      summary.push(
        `description="${embed.description.replace(/\r/g, " ").replace(/\n/g, " ")}"`
      );
    }

    lines.push(summary.length > 0 ? `  Embed: ${summary.join(", ")}` : "  Embed: [embed content]");
  }

  return lines.join("\n");
}

async function createTicketTranscript(channel, openTicket) {
  const closedAt = new Date().toISOString();
  const closedAtFormatted = formatUtcDateTime(closedAt);
  const allMessages = await fetchAllChannelMessages(channel);

  const transcriptLines = [
    `Ticket ID: ${openTicket.ticket_id}`,
    "Date and time format: DD-MM-YYYY HH:MM (24-hour UTC)",
    `Transcript generated at: ${closedAtFormatted}`,
    "",
    "Messages:",
    "==================================================",
  ];

  for (const message of allMessages) {
    transcriptLines.push(formatMessageForTranscript(message));
    transcriptLines.push("");
  }

  const transcriptFileName =
    `ticket-${openTicket.ticket_id.toLowerCase()}-` +
    `${formatTimestampForFilename(closedAt)}.txt`;
  const transcriptPath = path.join(TRANSCRIPTS_DIRECTORY, transcriptFileName);

  await fs.promises.writeFile(transcriptPath, transcriptLines.join("\n"), "utf8");

  return {
    closedAt,
    transcriptFileName,
    transcriptPath,
  };
}

async function sendTranscriptToLogs(
  guild,
  openTicket,
  closedByUserId,
  closeDetails,
  transcriptFileName,
  transcriptPath,
  closedAt
) {
  const transcriptLogChannel =
    guild.channels.cache.get(TRANSCRIPTS_CHANNEL_ID) ||
    (await guild.channels.fetch(TRANSCRIPTS_CHANNEL_ID).catch(() => null));

  if (
    !transcriptLogChannel ||
    !transcriptLogChannel.isTextBased() ||
    typeof transcriptLogChannel.send !== "function"
  ) {
    throw new Error(
      "TRANSCRIPTS_CHANNEL_ID must be a valid text channel ID where transcript logs can be sent."
    );
  }

  const transcriptEmbed = new EmbedBuilder()
    .setTitle("Ticket Closed")
    .setColor(0xd93025)
    .addFields(
      { name: "Ticket ID", value: openTicket.ticket_id, inline: true },
      {
        name: "Opened by",
        value: `<@${openTicket.discord_user_id}> (${openTicket.discord_user_id})`,
        inline: true,
      },
      {
        name: "Closed by",
        value: `<@${closedByUserId}> (${closedByUserId})`,
        inline: true,
      },
      {
        name: "Created reason",
        value: closeDetails.createdReason || "Not provided",
      },
      {
        name: "Closed reason",
        value: closeDetails.closedReason || "Not provided",
      }
    )
    .setTimestamp(new Date(closedAt));

  const transcriptAttachment = new AttachmentBuilder(transcriptPath, {
    name: transcriptFileName,
  });

  const sentLogMessage = await transcriptLogChannel.send({
    embeds: [transcriptEmbed],
    files: [transcriptAttachment],
  });

  return sentLogMessage && typeof sentLogMessage.url === "string" && sentLogMessage.url.length > 0
    ? sentLogMessage.url
    : null;
}

async function maybeDmTranscriptToTicketOwner(openTicket, transcriptFileName, transcriptPath) {
  if (!dmTranscriptUserOnTicketCloseEnabled) {
    return;
  }

  try {
    const ticketOwner =
      client.users.cache.get(openTicket.discord_user_id) ||
      (await client.users.fetch(openTicket.discord_user_id));

    if (!ticketOwner) {
      return;
    }

    const transcriptAttachment = new AttachmentBuilder(transcriptPath, {
      name: transcriptFileName,
    });

    await ticketOwner.send({
      content: [
        `Ticket ID: ${openTicket.ticket_id}`,
        "",
        "Your ticket has been closed, the transcript is attached below.",
      ].join("\n"),
      files: [transcriptAttachment],
    });
  } catch {
    // If DM delivery fails
    console.log(`Could not DM transcript to user ${openTicket.discord_user_id}. They may have DMs disabled or blocked the bot.`);
  }
}

async function maybeDeleteTranscriptFile(transcriptPath) {
  if (!autoDeleteTranscriptsEnabled) {
    return;
  }

  try {
    await fs.promises.unlink(transcriptPath);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.warn(`Failed to auto-delete transcript file: ${transcriptPath}`, error);
    }
  }
}

async function registerSlashCommands() {
  const commandData = SLASH_COMMANDS.map((command) => command.data.toJSON());
  const guilds = [...client.guilds.cache.values()];

  for (const guild of guilds) {
    await guild.commands.set(commandData);
  }

  console.log(`Registered ${commandData.length} slash command(s) in ${guilds.length} guild(s).`);
}

async function findExistingOpenTicketForUser(userId) {
  const openTicket = await dbGet(
    `
      SELECT discord_user_id, channel_id, ticket_id, info, created_at
      FROM open_tickets
      WHERE discord_user_id = ?
      LIMIT 1
    `,
    [userId]
  );

  if (!openTicket) {
    return null;
  }

  const channel =
    client.channels.cache.get(openTicket.channel_id) ||
    (await client.channels.fetch(openTicket.channel_id).catch(() => null));

  if (!channel) {
    await dbRun(`DELETE FROM open_tickets WHERE channel_id = ?`, [openTicket.channel_id]);
    return null;
  }

  return openTicket;
}

function formatBlacklistReason(reason) {
  const normalizedReason = sanitizeTicketInput(String(reason || ""));
  if (!normalizedReason) {
    return "No reason provided.";
  }

  return normalizedReason.length > 400
    ? `${normalizedReason.slice(0, 397)}...`
    : normalizedReason;
}

async function getBlacklistEntryForUser(userId) {
  return dbGet(
    `
      SELECT reason
      FROM blacklisted
      WHERE discord_user_id = ?
      LIMIT 1
    `,
    [userId]
  );
}

async function getOpenTicketByChannel(channelId) {
  return dbGet(
    `
      SELECT discord_user_id, channel_id, ticket_id, info, created_at
      FROM open_tickets
      WHERE channel_id = ?
      LIMIT 1
    `,
    [channelId]
  );
}

async function memberHasSupportRole(interaction) {
  if (!interaction.inGuild()) {
    return false;
  }

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);

    if (!supportRoleId) {
      if (!hasLoggedSupportRoleAdminFallback) {
        console.log(
          "SUPPORT_ROLE_ID is empty or not configured in .env. Falling back to Discord Administrator permission checks."
        );
        hasLoggedSupportRoleAdminFallback = true;
      }

      return member.permissions.has(PermissionFlagsBits.Administrator);
    }

    return member.roles.cache.has(supportRoleId);
  } catch (error) {
    console.error("Failed to verify support role:", error);
    return false;
  }
}

async function memberHasRole(interaction, roleId) {
  if (!interaction.inGuild() || !roleId) {
    return false;
  }

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    return member.roles.cache.has(roleId);
  } catch (error) {
    console.error("Failed to verify role:", error);
    return false;
  }
}

async function moveTicketToClosed(
  channelId,
  closedByUserId,
  infoJson,
  closedAtIsoTimestamp,
  linkToDiscordMessage = null
) {
  const openTicket = await getOpenTicketByChannel(channelId);
  if (!openTicket) {
    return null;
  }

  const closedAt = closedAtIsoTimestamp || new Date().toISOString();

  // Keep insert+delete atomic so tickets never exist in both tables after close.
  await dbRun("BEGIN TRANSACTION");

  try {
    await dbRun(
      `
        INSERT INTO closed_tickets (
          ticket_id,
          discord_user_id,
          closed_by,
          info,
          created_at,
          closed_at,
          link_to_discord_message
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        openTicket.ticket_id,
        openTicket.discord_user_id,
        closedByUserId,
        infoJson,
        openTicket.created_at,
        closedAt,
        linkToDiscordMessage,
      ]
    );

    await dbRun(`DELETE FROM open_tickets WHERE channel_id = ?`, [channelId]);

    await dbRun("COMMIT");
  } catch (error) {
    await dbRun("ROLLBACK").catch(() => {});
    throw error;
  }

  return {
    ticketId: openTicket.ticket_id,
    ticketOwnerId: openTicket.discord_user_id,
  };
}

async function resolvePanelChannel() {
  return (
    client.channels.cache.get(TICKET_PANEL_CHANNEL_ID) ||
    (await client.channels.fetch(TICKET_PANEL_CHANNEL_ID).catch(() => null))
  );
}

async function hasExistingPanelMessage(channel) {
  const recentMessages = await channel.messages.fetch({ limit: 25 });

  // Avoid posting duplicate panels every time the bot restarts.
  return recentMessages.some(
    (message) =>
      message.author.id === client.user.id &&
      message.components.some((row) =>
        row.components.some((component) => component.customId === CUSTOM_IDS.OPEN_TICKET_BUTTON)
      )
  );
}

async function ensureTicketPanelMessage() {
  const panelChannel = await resolvePanelChannel();

  if (!panelChannel || panelChannel.type !== ChannelType.GuildText) {
    console.error(
      "TICKET_PANEL_CHANNEL_ID must be a valid text channel ID where the panel message can be posted."
    );
    return;
  }

  const alreadyPosted = await hasExistingPanelMessage(panelChannel);
  if (alreadyPosted) {
    console.log("Ticket panel already exists in the configured panel channel.");
    return;
  }

  await panelChannel.send({
    embeds: [buildPanelEmbed()],
    components: [buildTicketButton()],
  });

  console.log(`Ticket panel posted in #${panelChannel.name}`);
}

async function createTicketChannel(interaction, answers) {
  const code = await generateUniqueTicketCode();
  const ticketName = `ticket-${code.toLowerCase()}`;

  // Default to private: owner + bot, then optionally add support role access.
  const permissionOverwrites = [
    {
      id: interaction.guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: interaction.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: interaction.client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
  ];

  if (supportRoleId) {
    permissionOverwrites.push({
      id: supportRoleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    });
  }

  const channel = await interaction.guild.channels.create({
    name: ticketName,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID,
    topic: `Ticket Owner: ${interaction.user.id}`,
    permissionOverwrites,
  });

  const createdAt = new Date().toISOString();
  const openTicketInfo = JSON.stringify({
    reportTarget: answers.reportTarget,
    issueDescription: answers.issueDescription,
  });

  await dbRun(
    `
      INSERT INTO open_tickets (
        discord_user_id,
        channel_id,
        ticket_id,
        info,
        created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `,
    [interaction.user.id, channel.id, code, openTicketInfo, createdAt]
  );

  const embed = new EmbedBuilder()
    .setTitle(`Ticket ${code}`)
    .setColor(0x2b84ff)
    .setDescription("A new support ticket has been created.")
    .addFields(
      {
        name: "Reported User (if report)",
        value: answers.reportTarget || "Not provided",
      },
      { name: "Issue Description", value: answers.issueDescription }
    )
    .setTimestamp();

  const supportMention = supportRoleId ? `<@&${supportRoleId}>` : "Support Team";

  await channel.send({
    content: `${interaction.user} opened this ticket. ${supportMention}`,
    embeds: [embed],
    components: [buildCloseTicketButton()],
  });

  return { channel, code };
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  if (!supportRoleId && !hasLoggedSupportRoleAdminFallback) {
    console.log(
      "SUPPORT_ROLE_ID is empty or not configured in .env. Falling back to Discord Administrator permission checks."
    );
    hasLoggedSupportRoleAdminFallback = true;
  }

  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }

  try {
    await ensureTicketPanelMessage();
  } catch (error) {
    console.error("Failed to auto-post ticket panel:", error);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      // Central command dispatcher; each module gets shared helpers via context.
      const command = SLASH_COMMANDS_BY_NAME.get(interaction.commandName);
      if (command) {
        await command.execute(interaction, {
          SUPPORT_ROLE_ID: supportRoleId,
          BLACKLIST_USAGE_ALLOWED_ROLEID,
          memberHasSupportRole,
          memberHasRole,
          dbRun,
          dbGet,
          dbAll,
        });
        return;
      }
    }

    if (
      interaction.isButton() &&
      ticketShowCommand.isPaginationButtonCustomId(interaction.customId)
    ) {
      const handled = await ticketShowCommand.handlePaginationButton(interaction, {
        SUPPORT_ROLE_ID: supportRoleId,
        memberHasSupportRole,
        dbGet,
        dbAll,
      });

      if (handled) {
        return;
      }
    }

    if (interaction.isButton() && interaction.customId === CUSTOM_IDS.OPEN_TICKET_BUTTON) {
      const blacklistEntry = await getBlacklistEntryForUser(interaction.user.id);
      if (blacklistEntry) {
        await interaction.reply({
          content: `You are blacklisted from opening tickets.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (oneOpenTicketPerUserEnabled) {
        const existingTicket = await findExistingOpenTicketForUser(interaction.user.id);
        if (existingTicket) {
          await interaction.reply({
            content: "You already have an open ticket",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      await interaction.showModal(buildTicketModal());
      return;
    }

    if (interaction.isButton() && interaction.customId === CUSTOM_IDS.CLOSE_TICKET_BUTTON) {
      const openTicket = await getOpenTicketByChannel(interaction.channelId);
      if (!openTicket) {
        await interaction.reply({
          content: "This channel is not an open ticket channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const hasSupportRole = await memberHasSupportRole(interaction);
      if (!hasSupportRole) {
        await interaction.reply({
          content: "You don't have permission to close tickets.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.showModal(buildCloseTicketModal());
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === CUSTOM_IDS.TICKET_MODAL) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const blacklistEntry = await getBlacklistEntryForUser(interaction.user.id);
      if (blacklistEntry) {
        await interaction.editReply(
          `You are blacklisted from opening tickets.\nReason: ${formatBlacklistReason(blacklistEntry.reason)}`
        );
        return;
      }

      const categoryChannel =
        interaction.guild.channels.cache.get(TICKET_CATEGORY_ID) ||
        (await interaction.guild.channels.fetch(TICKET_CATEGORY_ID).catch(() => null));

      if (!categoryChannel || categoryChannel.type !== ChannelType.GuildCategory) {
        await interaction.editReply(
          "Ticket category is missing or invalid. Check TICKET_CATEGORY_ID in .env."
        );
        return;
      }

      if (oneOpenTicketPerUserEnabled) {
        const existingTicket = await findExistingOpenTicketForUser(interaction.user.id);
        if (existingTicket) {
          await interaction.editReply(
            `You already have an open ticket: <#${existingTicket.channel_id}>. Please use that ticket.`
          );
          return;
        }
      }

      const answers = {
        reportTarget: validateAndSanitizeInput(
          interaction.fields.getTextInputValue(CUSTOM_IDS.REPORT_TARGET),
          "Reported user username/userID",
          false
        ),
        issueDescription: validateAndSanitizeInput(
          interaction.fields.getTextInputValue(CUSTOM_IDS.ISSUE_DESCRIPTION),
          "Issue description",
          true
        ),
      };

      const { channel, code } = await createTicketChannel(interaction, answers);

      await interaction.editReply(
        `Your ticket has been created: ${channel}`
      );
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === CUSTOM_IDS.CLOSE_TICKET_MODAL) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const hasSupportRole = await memberHasSupportRole(interaction);
      if (!hasSupportRole) {
        await interaction.editReply("You don't have permission to close tickets.");
        return;
      }

      const openTicket = await getOpenTicketByChannel(interaction.channelId);
      if (!openTicket) {
        await interaction.editReply("No open ticket record was found for this channel.");
        return;
      }

      const closeDetails = {
        createdReason: validateAndSanitizeInput(
          interaction.fields.getTextInputValue(CUSTOM_IDS.CREATED_REASON),
          "Created reason",
          false
        ),
        closedReason: validateAndSanitizeInput(
          interaction.fields.getTextInputValue(CUSTOM_IDS.CLOSED_REASON),
          "Closed reason",
          false
        ),
      };

      const transcriptResult = await createTicketTranscript(interaction.channel, openTicket);

      try {
        const logMessageUrl = await sendTranscriptToLogs(
          interaction.guild,
          openTicket,
          interaction.user.id,
          closeDetails,
          transcriptResult.transcriptFileName,
          transcriptResult.transcriptPath,
          transcriptResult.closedAt
        );

        await maybeDmTranscriptToTicketOwner(
          openTicket,
          transcriptResult.transcriptFileName,
          transcriptResult.transcriptPath
        );

        const closeInfoJson = JSON.stringify(closeDetails);

        const closedTicket = await moveTicketToClosed(
          interaction.channelId,
          interaction.user.id,
          closeInfoJson,
          transcriptResult.closedAt,
          logMessageUrl
        );

        if (!closedTicket) {
          await interaction.editReply("No open ticket record was found for this channel.");
          return;
        }

        await interaction.editReply(
          `Ticket ${closedTicket.ticketId} was closed. Deleting channel now.`
        );

        await interaction.channel.delete(`Ticket ${closedTicket.ticketId} closed by support staff`);
        return;
      } finally {
        // Cleanup runs even when close flow errors after transcript creation.
        await maybeDeleteTranscriptFile(transcriptResult.transcriptPath);
      }
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(error.message);
        return;
      }

      await interaction.reply({
        content: error.message,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    console.error("Interaction handler error:", error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply("Something went wrong while processing your request.");
      return;
    }

    await interaction.reply({
      content: "Something went wrong while processing your request.",
      flags: MessageFlags.Ephemeral,
    });
  }
});

async function startBot() {
  try {
    await initializeDatabase();
    await client.login(DISCORD_TOKEN);
  } catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

startBot();
