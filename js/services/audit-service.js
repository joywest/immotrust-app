// js/services/audit-service.js
// Service central de journalisation (auditLogs) — Centre de preuves ImmoTrust.
// Chaque événement important de l'application doit passer par AuditService.log()
// afin de garantir une source de vérité unique pour l'historique / les preuves.

import { ref, push, set } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

/**
 * Enregistre un événement dans auditLogs/{logId}.
 * @param {import("firebase/database").Database} db
 * @param {{
 *   ownerId: string,
 *   actorId: string,
 *   actorRole: "proprietaire"|"locataire"|"admin",
 *   action: string,
 *   entityType: string,
 *   entityId: string,
 *   description: string
 * }} data
 */
export async function logAction(db, data) {
    const logsRef = ref(db, "auditLogs");
    const newLogRef = push(logsRef);
    await set(newLogRef, {
        ownerId: data.ownerId || null,
        actorId: data.actorId || null,
        actorRole: data.actorRole || "proprietaire",
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId || null,
        description: data.description || "",
        timestamp: Date.now()
    });
    return newLogRef.key;
}