const { removeFaceProfileForUser } = require("./faceVerification");
const {
  getCompanyById,
  findUserById,
  listUserIdsByCompanyId,
  deleteUserById,
  deleteCompanyById,
  isSystemAdminAccount,
} = require("./tenantStore");

/**
 * Remove face metadata (Mongo/SQLite) and on-disk reference images for a user.
 */
async function purgeUserFaceAssets(userId) {
  await removeFaceProfileForUser(userId);
}

/**
 * Delete a workspace user: face assets, then tenant record (Mongo or SQLite).
 */
async function purgeWorkspaceUser(userId) {
  const id = String(userId || "").trim();
  if (!id) {
    return { removed: false, reason: "missing_user_id" };
  }

  const user = await Promise.resolve(findUserById(id));
  if (!user) {
    return { removed: false, reason: "not_found", user_id: id };
  }

  if (isSystemAdminAccount(user)) {
    return { removed: false, reason: "system_admin_protected", user_id: id };
  }

  await purgeUserFaceAssets(id);
  const removed = await Promise.resolve(deleteUserById(id));

  return {
    removed: Boolean(removed),
    user_id: id,
    username: user.username,
    company_id: user.company_id,
  };
}

/**
 * Delete a company and every user in that tenant, including face profiles on disk.
 */
async function purgeCompanyWithUsers(companyId) {
  const id = String(companyId || "").trim();
  if (!id) {
    return { removed: false, reason: "missing_company_id" };
  }

  const company = await Promise.resolve(getCompanyById(id));
  if (!company) {
    return { removed: false, reason: "not_found", company_id: id };
  }

  const userIds = await Promise.resolve(listUserIdsByCompanyId(id));
  let faces_purged = 0;

  for (const userId of userIds) {
    await purgeUserFaceAssets(userId);
    faces_purged += 1;
  }

  const removed = await Promise.resolve(deleteCompanyById(id));

  return {
    removed: Boolean(removed),
    company_id: id,
    users_removed: userIds.length,
    faces_purged,
  };
}

module.exports = {
  purgeUserFaceAssets,
  purgeWorkspaceUser,
  purgeCompanyWithUsers,
};
