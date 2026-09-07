// js/services/invitation-service.js
// Vérifie une invitation locataire et crée le compte Firebase Auth associé.
// Le rôle et les rattachements (ownerId/tenantId/leaseId) sont écrits UNE SEULE FOIS
// ici, côté "serveur logique" de l'appli, jamais recopiés depuis l'URL ou un input.

import { ref, get, update } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { logAction } from "./audit-service.js";

async function hashCode(code) {
    const enc = new TextEncoder().encode(code);
    const digest = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Charge une invitation et vérifie code + expiration + statut.
 * @returns {Promise<{ok:true, invitation:object} | {ok:false, reason:"not_found"|"expired"|"used"|"bad_code"}>}
 */
export async function verifyInvitation(db, invitationId, rawCode) {
    if (!invitationId || !rawCode) return { ok: false, reason: "not_found" };

    const snap = await get(ref(db, `invitations/${invitationId}`));
    if (!snap.exists()) return { ok: false, reason: "not_found" };

    const invitation = snap.val();

    if (invitation.status !== "pending") return { ok: false, reason: "used" };
    if (Date.now() > invitation.expiresAt) return { ok: false, reason: "expired" };

    const candidateHash = await hashCode(rawCode);
    if (candidateHash !== invitation.codeHash) return { ok: false, reason: "bad_code" };

    return { ok: true, invitation };
}

/**
 * Crée le compte Firebase Auth du locataire, lie son profil et clôture l'invitation.
 * @param {import("firebase/auth").Auth} auth
 * @param {import("firebase/database").Database} db
 * @param {string} invitationId
 * @param {object} invitation  (renvoyé par verifyInvitation)
 * @param {{email:string, password:string}} credentials
 */
export async function acceptInvitation(auth, db, invitationId, invitation, credentials) {
    // Re-vérification juste avant la création du compte (évite une double acceptation)
    const freshSnap = await get(ref(db, `invitations/${invitationId}`));
    if (!freshSnap.exists() || freshSnap.val().status !== "pending") {
        throw new Error("Cette invitation a déjà été utilisée.");
    }

    const userCredential = await createUserWithEmailAndPassword(auth, credentials.email, credentials.password);
    const uid = userCredential.user.uid;
    const now = Date.now();

    const updates = {};
    updates[`users/${uid}`] = {
        role: "locataire",
        ownerId: invitation.ownerId,
        tenantId: invitation.tenantId,
        leaseId: invitation.leaseId,
        name: invitation.tenantName,
        email: credentials.email,
        status: "active",
        createdAt: now
    };
    updates[`tenants/${invitation.tenantId}/uid`] = uid;
    updates[`tenants/${invitation.tenantId}/status`] = "active";
    updates[`invitations/${invitationId}/status`] = "accepted";
    updates[`invitations/${invitationId}/acceptedAt`] = now;
    updates[`invitations/${invitationId}/acceptedUid`] = uid;

    await update(ref(db), updates);

    await logAction(db, {
        ownerId: invitation.ownerId,
        actorId: uid,
        actorRole: "locataire",
        action: "TENANT_INVITATION_ACCEPTED",
        entityType: "tenant",
        entityId: invitation.tenantId,
        description: `${invitation.tenantName} a créé son compte locataire`
    });

    return uid;
}