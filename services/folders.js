const crypto = require("crypto");
const Folder = require("../models/Folder");

const FOLDER_ID_PREFIX = "fld_";

function normalizeFolderId(raw) {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed === "null" || trimmed === "root") return null;
  return trimmed;
}

async function getFolderById(folderId) {
  const id = normalizeFolderId(folderId);
  if (!id) return null;
  return Folder.findOne({ id }).lean();
}

async function listFoldersForUser({ user_id, company_id }) {
  const uid = String(user_id || "").trim();
  const cid = String(company_id || "").trim();
  if (!uid || !cid) return [];

  const folders = await Folder.find({ user_id: uid, company_id: cid }).sort({ created_at: -1 }).lean();
  return folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    user_id: folder.user_id,
    company_id: folder.company_id,
    created_at: folder.created_at,
  }));
}

async function createFolderForUser({ name, user_id, company_id }) {
  const folderName = String(name || "").trim();
  const uid = String(user_id || "").trim();
  const cid = String(company_id || "").trim();

  if (!folderName) {
    throw new Error("Folder name is required.");
  }
  if (!uid || !cid) {
    throw new Error("user_id and company_id are required.");
  }

  const duplicate = await Folder.findOne({
    user_id: uid,
    company_id: cid,
    name: new RegExp(`^${folderName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
  }).lean();

  if (duplicate) {
    throw new Error(`A folder named "${folderName}" already exists.`);
  }

  const folder = {
    id: `${FOLDER_ID_PREFIX}${crypto.randomBytes(6).toString("hex")}`,
    name: folderName,
    user_id: uid,
    company_id: cid,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  await Folder.create(folder);
  return folder;
}

async function assertFolderAccess(folderId, { user_id, company_id }) {
  const id = normalizeFolderId(folderId);
  if (!id) return null;

  const folder = await getFolderById(id);
  if (!folder) {
    throw new Error("Folder not found.");
  }

  const uid = String(user_id || "").trim();
  const cid = String(company_id || "").trim();

  if (uid && folder.user_id !== uid) {
    throw new Error("Folder not found.");
  }
  if (cid && folder.company_id !== cid) {
    throw new Error("Folder not found.");
  }

  return folder;
}

module.exports = {
  normalizeFolderId,
  getFolderById,
  listFoldersForUser,
  createFolderForUser,
  assertFolderAccess,
};
