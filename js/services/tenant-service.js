// js/services/tenant-service.js
// Module métier "Locataires + Invitations" — Phase 5 du prompt maître ImmoTrust.
//
// Ce service NE fait jamais confiance au frontend pour la sécurité : il prépare
// des données propres, mais la vraie frontière de sécurité reste les Firebase
// Security Rules (à écrire en phase 20). Il ne crée jamais de mot de passe
// locataire à la place du propriétaire — un système d'invitation à code est
// utilisé à la place (section 11 du prompt maître).

import { ref, push, set, update } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { logAction } from "./audit-service.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

/** Génère un code d'invitation lisible à 8 caractères (ex: "K3F9-2QX7"). */
function generateInvitationCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans 0/O/1/I pour éviter la confusion
    let raw = "";
    for (let i = 0; i < 8; i++) {
        raw += chars[Math.floor(Math.random() * chars.length)];
    }
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Hash SHA-256 du code (on ne stocke jamais le code en clair dans la base). */
async function hashCode(code) {
    const enc = new TextEncoder().encode(code);
    const digest = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

/** "2026-09" pour une date donnée (ou aujourd'hui). */
function monthKeyOf(dateStr) {
    const d = dateStr ? new Date(dateStr) : new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
}

/**
 * Crée un locataire, son contrat (lease), sa première obligation de loyer
 * et son invitation, puis met à jour le statut du logement.
 * Ne crée PAS de compte Firebase Auth ici — cela se fait via acceptInvitation().
 *
 * @param {import("firebase/database").Database} db
 * @param {{
 *   ownerId: string,
 *   propertyId: string,
 *   propertyName: string,
 *   name: string,
 *   phone: string,
 *   email: string,
 *   entryDate: string,      // "2026-09-05"
 *   monthlyRent: number,
 *   depositExpected: number,
 *   notes?: string
 * }} params
 * @returns {Promise<{tenantId:string, leaseId:string, obligationId:string, invitationId:string, rawCode:string}>}
 */
export async function createTenantWithInvitation(db, params) {
    const {
        ownerId, propertyId, propertyName,
        name, phone, email,
        entryDate, monthlyRent, depositExpected, notes
    } = params;

    if (!ownerId || !propertyId) throw new Error("ownerId et propertyId sont requis.");
    if (!name || !entryDate) throw new Error("Nom et date d'entrée sont requis.");
    if (!email) throw new Error("Email du locataire requis pour créer son invitation.");

    const now = Date.now();

    // 1. Locataire
    const tenantId = push(ref(db, "tenants")).key;
    const tenantData = {
        ownerId,
        propertyId,
        name,
        phone: phone || "",
        email,
        status: "invited", // invited -> active une fois l'invitation acceptée
        uid: null,
        createdAt: now
    };

    // 2. Contrat (lease) — le loyer y est figé, l'historique des obligations n'en dépendra jamais
    const leaseId = push(ref(db, "leases")).key;
    const leaseData = {
        ownerId,
        propertyId,
        tenantId,
        startDate: entryDate,
        endDate: null,
        monthlyRent: Number(monthlyRent || 0),
        depositExpected: Number(depositExpected || 0),
        status: "active",
        createdAt: now
    };

    // 3. Première obligation de loyer du mois d'entrée
    const obligationId = push(ref(db, "rentObligations")).key;
    const obligationData = {
        ownerId,
        tenantId,
        propertyId,
        leaseId,
        monthKey: monthKeyOf(entryDate),
        expectedAmount: Number(monthlyRent || 0),
        dueDate: entryDate,
        status: "unpaid"
    };

    // 4. Caution attendue
    const depositId = push(ref(db, "deposits")).key;
    const depositData = {
        ownerId,
        tenantId,
        leaseId,
        expectedAmount: Number(depositExpected || 0),
        paidAmount: 0,
        refundedAmount: 0,
        balance: Number(depositExpected || 0),
        status: "requested",
        createdAt: now
    };

    // 5. Invitation (code à usage unique, jamais le mot de passe du locataire)
    const invitationId = push(ref(db, "invitations")).key;
    const rawCode = generateInvitationCode();
    const codeHash = await hashCode(rawCode);
    const invitationData = {
        ownerId,
        propertyId,
        leaseId,
        tenantId,
        tenantName: name,
        propertyName: propertyName || "",
        codeHash,
        expiresAt: now + INVITATION_TTL_MS,
        status: "pending",
        createdAt: now
    };

    // Écriture atomique multi-chemins
    const updates = {};
    updates[`tenants/${tenantId}`] = tenantData;
    updates[`leases/${leaseId}`] = leaseData;
    updates[`rentObligations/${obligationId}`] = obligationData;
    updates[`deposits/${depositId}`] = depositData;
    updates[`invitations/${invitationId}`] = invitationData;
    if (notes) updates[`tenants/${tenantId}/notes`] = notes;
    // Le logement reste pour l'instant dans users/{ownerId}/properties (migration complète en phase 4)
    updates[`users/${ownerId}/properties/${propertyId}/status`] = "occupé";
    updates[`users/${ownerId}/properties/${propertyId}/tenantId`] = tenantId;

    await update(ref(db), updates);

    await logAction(db, {
        ownerId,
        actorId: ownerId,
        actorRole: "proprietaire",
        action: "TENANT_CREATED",
        entityType: "tenant",
        entityId: tenantId,
        description: `Locataire ${name} ajouté pour le logement ${propertyName || propertyId}`
    });
    await logAction(db, {
        ownerId,
        actorId: ownerId,
        actorRole: "proprietaire",
        action: "INVITATION_CREATED",
        entityType: "invitation",
        entityId: invitationId,
        description: `Invitation créée pour ${name}`
    });

    const invitationLink = `${window.location.origin}${window.location.pathname.replace(/dashboard\.html$/, "")}invite.html?id=${invitationId}&code=${encodeURIComponent(rawCode)}`;

    return { tenantId, leaseId, obligationId, depositId, invitationId, rawCode, invitationLink };
}