const { EmbedBuilder, MessageFlags, SlashCommandBuilder } = require("discord.js");

const data = new SlashCommandBuilder()
  .setName("blacklist")
  .setDescription("Manage blacklisted users")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Add a user to blacklist")
      .addStringOption((option) =>
        option
          .setName("user")
          .setDescription("Mention a user or provide their user ID")
          .setRequired(true)
      )
      .addStringOption((option) =>
        option
          .setName("reason")
          .setDescription("Reason for blacklisting")
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Remove a user from blacklist")
      .addStringOption((option) =>
        option
          .setName("user")
          .setDescription("Mention a user or provide their user ID")
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) => subcommand.setName("list").setDescription("List blacklisted users"));

function parseUserIdFromInput(userInput) {
  const value = String(userInput).trim();
  // Support both a proper mention and a raw snowflake so staff can paste either.
  const mentionMatch = value.match(/^<@!?(\d+)>$/);

  if (mentionMatch) {
    return mentionMatch[1];
  }

  if (/^\d{17,20}$/.test(value)) {
    return value;
  }

  return null;
}

function normalizeRoleId(roleId) {
  const value = String(roleId || "").trim();
  return /^\d{17,20}$/.test(value) ? value : null;
}

async function ensureBlacklistCommandAccess(interaction, context) {
  const {
    BLACKLIST_USAGE_ALLOWED_ROLEID,
    memberHasSupportRole,
    memberHasRole,
  } = context;

  const restrictedRoleId = normalizeRoleId(BLACKLIST_USAGE_ALLOWED_ROLEID);

  // If a dedicated blacklist role is configured, it takes priority over support-role fallback.
  if (restrictedRoleId) {
    const hasRestrictedRole = await memberHasRole(interaction, restrictedRoleId);
    if (!hasRestrictedRole) {
      await interaction.reply({
        content: "You don't have permission to use blacklist commands.",
        flags: MessageFlags.Ephemeral,
      });
      return false;
    }

    return true;
  }

  const hasSupportRole = await memberHasSupportRole(interaction);
  if (!hasSupportRole) {
    await interaction.reply({
      content: "You don't have permission to use blacklist commands.",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  return true;
}

async function executeAdd(interaction, context) {
  const { dbRun } = context;

  const userInput = interaction.options.getString("user", true);
  const reasonInput = interaction.options.getString("reason", true);
  const targetUserId = parseUserIdFromInput(userInput);

  if (!targetUserId) {
    await interaction.editReply(
      "Invalid user value. Use a user mention (for example, <@123...>) or a user ID."
    );
    return;
  }

  const reason = reasonInput.trim();
  if (!reason) {
    await interaction.editReply("Reason is required.");
    return;
  }

  // Upsert so repeated /blacklist add updates the reason instead of creating duplicate rows.
  await dbRun(
    `
      INSERT INTO blacklisted (
        discord_user_id,
        reason,
        blacklisted_by,
        created_at
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(discord_user_id) DO UPDATE SET
        reason = excluded.reason,
        blacklisted_by = excluded.blacklisted_by,
        created_at = excluded.created_at
    `,
    [targetUserId, reason, interaction.user.id, new Date().toISOString()]
  );

  const embed = new EmbedBuilder()
    .setColor(0xd93025)
    .setTitle("Blacklist Updated")
    .setDescription(`<@${targetUserId}> is now blacklisted.`)
    .addFields(
      { name: "User ID", value: targetUserId, inline: true },
      { name: "Reason", value: reason }
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function executeRemove(interaction, context) {
  const { dbGet, dbRun } = context;

  const userInput = interaction.options.getString("user", true);
  const targetUserId = parseUserIdFromInput(userInput);

  if (!targetUserId) {
    await interaction.editReply(
      "Invalid user value. Use a user mention (for example, <@123...>) or a user ID."
    );
    return;
  }

  const existingRow = await dbGet(
    `
      SELECT discord_user_id
      FROM blacklisted
      WHERE discord_user_id = ?
      LIMIT 1
    `,
    [targetUserId]
  );

  if (!existingRow) {
    await interaction.editReply("That user is not in the blacklist.");
    return;
  }

  await dbRun(
    `
      DELETE FROM blacklisted
      WHERE discord_user_id = ?
    `,
    [targetUserId]
  );

  const embed = new EmbedBuilder()
    .setColor(0x2b84ff)
    .setTitle("Blacklist Updated")
    .setDescription(`<@${targetUserId}> was removed from the blacklist.`)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

function buildBlacklistListEmbeds(rows) {
  const lines = rows.map((row, index) => {
    const reason = String(row.reason || "No reason");
    const safeReason = reason.length > 250 ? `${reason.slice(0, 247)}...` : reason;

    return (
      `${index + 1}. <@${row.discord_user_id}> (${row.discord_user_id})\n` +
      `   Reason: ${safeReason}\n` +
      `   By: <@${row.blacklisted_by}>\n` +
      `   At: ${row.created_at}`
    );
  });

  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const line of lines) {
    // Keep embed descriptions below Discord's hard character limit.
    if (currentLength + line.length + 2 > 3500) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }

    current.push(line);
    currentLength += line.length + 2;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  // Discord allows up to 10 embeds per message.
  const embeds = chunks.slice(0, 10).map((chunk, index) =>
    new EmbedBuilder()
      .setColor(0xd93025)
      .setTitle("Blacklisted Users")
      .setDescription(chunk.join("\n\n"))
      .setFooter({
        text: `Page ${index + 1}/${Math.min(chunks.length, 10)} • Total users: ${rows.length}`,
      })
  );

  if (chunks.length > 10 && embeds.length > 0) {
    const lastEmbed = embeds[embeds.length - 1];
    const previousDescription = lastEmbed.data.description || "";
    lastEmbed.setDescription(`${previousDescription}\n\n...more results omitted.`);
  }

  return embeds;
}

async function executeList(interaction, context) {
  const { dbAll } = context;

  const rows = await dbAll(
    `
      SELECT discord_user_id, reason, blacklisted_by, created_at
      FROM blacklisted
      ORDER BY created_at DESC
    `
  );

  if (rows.length === 0) {
    const embed = new EmbedBuilder()
      .setColor(0x2b84ff)
      .setTitle("Blacklisted Users")
      .setDescription("No blacklisted users found.");

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const embeds = buildBlacklistListEmbeds(rows);
  await interaction.editReply({ embeds });
}

async function execute(interaction, context) {
  // Check permissions first so denial messages can be sent as immediate ephemeral replies.
  const hasBlacklistAccess = await ensureBlacklistCommandAccess(interaction, context);
  if (!hasBlacklistAccess) {
    return;
  }

  await interaction.deferReply();

  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === "add") {
    await executeAdd(interaction, context);
    return;
  }

  if (subcommand === "remove") {
    await executeRemove(interaction, context);
    return;
  }

  if (subcommand === "list") {
    await executeList(interaction, context);
    return;
  }

  await interaction.editReply("Unsupported subcommand.");
}

module.exports = {
  data,
  execute,
};
