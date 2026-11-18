import { relations } from "drizzle-orm/relations";
import { users, chatTemplates, staffProfiles, applications, applicationMessages, applicationAssignmentHistory, conversations, partnerDocuments, auditLog, clientDocuments, clientDocumentVersions, serviceCategories, serviceSubcategories, services, serviceDeadlineRules, teamAccessRequests, partnerProfiles, applicationEscalations, applicationDocuments, clientSubscriptions, subscriptionPlans, messageReferences, messageEdits, dedicatedAgentFocus, clientObligations, applicationStatusHistory, servicePriceBands, serviceStructureVersions, termsAcceptances, messageAttachments, payments, paymentSplits, refreshTokens, platformSettings, passwordResetTokens, agentSettings, agentServiceSkills, backupCodes, servicePricingTiers, trustedDevices, agentDocuments, messageMentions, messageReactions, threadReads, conversationParticipants } from "./schema";

export const chatTemplatesRelations = relations(chatTemplates, ({one}) => ({
	user: one(users, {
		fields: [chatTemplates.createdBy],
		references: [users.userId]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	chatTemplates: many(chatTemplates),
	staffProfiles: many(staffProfiles),
	applicationMessages_deletedBy: many(applicationMessages, {
		relationName: "applicationMessages_deletedBy_users_userId"
	}),
	applicationMessages_pinnedBy: many(applicationMessages, {
		relationName: "applicationMessages_pinnedBy_users_userId"
	}),
	applicationMessages_senderId: many(applicationMessages, {
		relationName: "applicationMessages_senderId_users_userId"
	}),
	partnerDocuments_partnerId: many(partnerDocuments, {
		relationName: "partnerDocuments_partnerId_users_userId"
	}),
	partnerDocuments_reviewedBy: many(partnerDocuments, {
		relationName: "partnerDocuments_reviewedBy_users_userId"
	}),
	partnerDocuments_uploadedBy: many(partnerDocuments, {
		relationName: "partnerDocuments_uploadedBy_users_userId"
	}),
	auditLogs: many(auditLog),
	teamAccessRequests: many(teamAccessRequests),
	services: many(services),
	partnerProfiles_referredByAgentId: many(partnerProfiles, {
		relationName: "partnerProfiles_referredByAgentId_users_userId"
	}),
	partnerProfiles_userId: many(partnerProfiles, {
		relationName: "partnerProfiles_userId_users_userId"
	}),
	applicationEscalations_escalatedBy: many(applicationEscalations, {
		relationName: "applicationEscalations_escalatedBy_users_userId"
	}),
	applicationEscalations_relatedUserId: many(applicationEscalations, {
		relationName: "applicationEscalations_relatedUserId_users_userId"
	}),
	applicationEscalations_resolvedBy: many(applicationEscalations, {
		relationName: "applicationEscalations_resolvedBy_users_userId"
	}),
	applicationDocuments: many(applicationDocuments),
	clientDocuments: many(clientDocuments),
	clientSubscriptions_assignedBy: many(clientSubscriptions, {
		relationName: "clientSubscriptions_assignedBy_users_userId"
	}),
	clientSubscriptions_clientId: many(clientSubscriptions, {
		relationName: "clientSubscriptions_clientId_users_userId"
	}),
	clientSubscriptions_dedicatedAgentId: many(clientSubscriptions, {
		relationName: "clientSubscriptions_dedicatedAgentId_users_userId"
	}),
	messageEdits: many(messageEdits),
	clientObligations_clientId: many(clientObligations, {
		relationName: "clientObligations_clientId_users_userId"
	}),
	clientObligations_resolvedBy: many(clientObligations, {
		relationName: "clientObligations_resolvedBy_users_userId"
	}),
	applicationStatusHistories: many(applicationStatusHistory),
	applications_assignedAgentId: many(applications, {
		relationName: "applications_assignedAgentId_users_userId"
	}),
	applications_assignedPartnerId: many(applications, {
		relationName: "applications_assignedPartnerId_users_userId"
	}),
	applications_clientId: many(applications, {
		relationName: "applications_clientId_users_userId"
	}),
	applications_dueSetBy: many(applications, {
		relationName: "applications_dueSetBy_users_userId"
	}),
	termsAcceptances: many(termsAcceptances),
	messageAttachments: many(messageAttachments),
	paymentSplits: many(paymentSplits),
	refreshTokens: many(refreshTokens),
	platformSettings: many(platformSettings),
	passwordResetTokens: many(passwordResetTokens),
	applicationAssignmentHistories_newAgentId: many(applicationAssignmentHistory, {
		relationName: "applicationAssignmentHistory_newAgentId_users_userId"
	}),
	applicationAssignmentHistories_performedBy: many(applicationAssignmentHistory, {
		relationName: "applicationAssignmentHistory_performedBy_users_userId"
	}),
	applicationAssignmentHistories_previousAgentId: many(applicationAssignmentHistory, {
		relationName: "applicationAssignmentHistory_previousAgentId_users_userId"
	}),
	agentSettings: many(agentSettings),
	agentServiceSkills: many(agentServiceSkills),
	backupCodes: many(backupCodes),
	trustedDevices: many(trustedDevices),
	agentDocuments_agentId: many(agentDocuments, {
		relationName: "agentDocuments_agentId_users_userId"
	}),
	agentDocuments_reviewedBy: many(agentDocuments, {
		relationName: "agentDocuments_reviewedBy_users_userId"
	}),
	messageMentions: many(messageMentions),
	messageReactions: many(messageReactions),
	threadReads: many(threadReads),
	conversationParticipants: many(conversationParticipants),
}));

export const staffProfilesRelations = relations(staffProfiles, ({one}) => ({
	user: one(users, {
		fields: [staffProfiles.userId],
		references: [users.userId]
	}),
}));

export const applicationMessagesRelations = relations(applicationMessages, ({one, many}) => ({
	application: one(applications, {
		fields: [applicationMessages.applicationId],
		references: [applications.applicationId]
	}),
	applicationAssignmentHistory: one(applicationAssignmentHistory, {
		fields: [applicationMessages.assignmentId],
		references: [applicationAssignmentHistory.id]
	}),
	conversation: one(conversations, {
		fields: [applicationMessages.conversationId],
		references: [conversations.conversationId]
	}),
	user_deletedBy: one(users, {
		fields: [applicationMessages.deletedBy],
		references: [users.userId],
		relationName: "applicationMessages_deletedBy_users_userId"
	}),
	user_pinnedBy: one(users, {
		fields: [applicationMessages.pinnedBy],
		references: [users.userId],
		relationName: "applicationMessages_pinnedBy_users_userId"
	}),
	applicationMessage: one(applicationMessages, {
		fields: [applicationMessages.replyToId],
		references: [applicationMessages.messageId],
		relationName: "applicationMessages_replyToId_applicationMessages_messageId"
	}),
	applicationMessages: many(applicationMessages, {
		relationName: "applicationMessages_replyToId_applicationMessages_messageId"
	}),
	user_senderId: one(users, {
		fields: [applicationMessages.senderId],
		references: [users.userId],
		relationName: "applicationMessages_senderId_users_userId"
	}),
	messageReferences: many(messageReferences),
	messageEdits: many(messageEdits),
	messageAttachments: many(messageAttachments),
	messageMentions: many(messageMentions),
	messageReactions: many(messageReactions),
}));

export const applicationsRelations = relations(applications, ({one, many}) => ({
	applicationMessages: many(applicationMessages),
	applicationEscalations: many(applicationEscalations),
	applicationDocuments: many(applicationDocuments),
	clientObligations: many(clientObligations),
	applicationStatusHistories: many(applicationStatusHistory),
	user_assignedAgentId: one(users, {
		fields: [applications.assignedAgentId],
		references: [users.userId],
		relationName: "applications_assignedAgentId_users_userId"
	}),
	user_assignedPartnerId: one(users, {
		fields: [applications.assignedPartnerId],
		references: [users.userId],
		relationName: "applications_assignedPartnerId_users_userId"
	}),
	user_clientId: one(users, {
		fields: [applications.clientId],
		references: [users.userId],
		relationName: "applications_clientId_users_userId"
	}),
	applicationAssignmentHistory: one(applicationAssignmentHistory, {
		fields: [applications.currentAssignmentId],
		references: [applicationAssignmentHistory.id],
		relationName: "applications_currentAssignmentId_applicationAssignmentHistory_id"
	}),
	user_dueSetBy: one(users, {
		fields: [applications.dueSetBy],
		references: [users.userId],
		relationName: "applications_dueSetBy_users_userId"
	}),
	servicePriceBand: one(servicePriceBands, {
		fields: [applications.priceBandId],
		references: [servicePriceBands.id]
	}),
	service: one(services, {
		fields: [applications.serviceId],
		references: [services.serviceId]
	}),
	serviceStructureVersion: one(serviceStructureVersions, {
		fields: [applications.structureVersionId],
		references: [serviceStructureVersions.id]
	}),
	messageAttachments: many(messageAttachments),
	applicationAssignmentHistories: many(applicationAssignmentHistory, {
		relationName: "applicationAssignmentHistory_applicationId_applications_applicationId"
	}),
	conversations: many(conversations),
	threadReads: many(threadReads),
}));

export const applicationAssignmentHistoryRelations = relations(applicationAssignmentHistory, ({one, many}) => ({
	applicationMessages: many(applicationMessages),
	applications: many(applications, {
		relationName: "applications_currentAssignmentId_applicationAssignmentHistory_id"
	}),
	application: one(applications, {
		fields: [applicationAssignmentHistory.applicationId],
		references: [applications.applicationId],
		relationName: "applicationAssignmentHistory_applicationId_applications_applicationId"
	}),
	user_newAgentId: one(users, {
		fields: [applicationAssignmentHistory.newAgentId],
		references: [users.userId],
		relationName: "applicationAssignmentHistory_newAgentId_users_userId"
	}),
	user_performedBy: one(users, {
		fields: [applicationAssignmentHistory.performedBy],
		references: [users.userId],
		relationName: "applicationAssignmentHistory_performedBy_users_userId"
	}),
	user_previousAgentId: one(users, {
		fields: [applicationAssignmentHistory.previousAgentId],
		references: [users.userId],
		relationName: "applicationAssignmentHistory_previousAgentId_users_userId"
	}),
}));

export const conversationsRelations = relations(conversations, ({one, many}) => ({
	applicationMessages: many(applicationMessages),
	messageAttachments: many(messageAttachments),
	application: one(applications, {
		fields: [conversations.applicationId],
		references: [applications.applicationId]
	}),
	conversationParticipants: many(conversationParticipants),
}));

export const partnerDocumentsRelations = relations(partnerDocuments, ({one}) => ({
	user_partnerId: one(users, {
		fields: [partnerDocuments.partnerId],
		references: [users.userId],
		relationName: "partnerDocuments_partnerId_users_userId"
	}),
	user_reviewedBy: one(users, {
		fields: [partnerDocuments.reviewedBy],
		references: [users.userId],
		relationName: "partnerDocuments_reviewedBy_users_userId"
	}),
	user_uploadedBy: one(users, {
		fields: [partnerDocuments.uploadedBy],
		references: [users.userId],
		relationName: "partnerDocuments_uploadedBy_users_userId"
	}),
}));

export const auditLogRelations = relations(auditLog, ({one}) => ({
	user: one(users, {
		fields: [auditLog.actorId],
		references: [users.userId]
	}),
}));

export const clientDocumentVersionsRelations = relations(clientDocumentVersions, ({one}) => ({
	clientDocument: one(clientDocuments, {
		fields: [clientDocumentVersions.documentId],
		references: [clientDocuments.documentId]
	}),
}));

export const clientDocumentsRelations = relations(clientDocuments, ({one, many}) => ({
	clientDocumentVersions: many(clientDocumentVersions),
	applicationDocuments: many(applicationDocuments),
	user: one(users, {
		fields: [clientDocuments.clientId],
		references: [users.userId]
	}),
}));

export const serviceSubcategoriesRelations = relations(serviceSubcategories, ({one, many}) => ({
	serviceCategory: one(serviceCategories, {
		fields: [serviceSubcategories.categoryId],
		references: [serviceCategories.id]
	}),
	services: many(services),
}));

export const serviceCategoriesRelations = relations(serviceCategories, ({many}) => ({
	serviceSubcategories: many(serviceSubcategories),
	services: many(services),
}));

export const serviceDeadlineRulesRelations = relations(serviceDeadlineRules, ({one, many}) => ({
	service: one(services, {
		fields: [serviceDeadlineRules.serviceId],
		references: [services.serviceId]
	}),
	clientObligations: many(clientObligations),
}));

export const servicesRelations = relations(services, ({one, many}) => ({
	serviceDeadlineRules: many(serviceDeadlineRules),
	serviceCategory: one(serviceCategories, {
		fields: [services.categoryId],
		references: [serviceCategories.id]
	}),
	user: one(users, {
		fields: [services.createdBy],
		references: [users.userId]
	}),
	serviceSubcategory: one(serviceSubcategories, {
		fields: [services.subcategoryId],
		references: [serviceSubcategories.id]
	}),
	dedicatedAgentFoci: many(dedicatedAgentFocus),
	clientObligations: many(clientObligations),
	applications: many(applications),
	serviceStructureVersions: many(serviceStructureVersions),
	servicePricingTiers: many(servicePricingTiers),
	servicePriceBands: many(servicePriceBands),
}));

export const teamAccessRequestsRelations = relations(teamAccessRequests, ({one}) => ({
	user: one(users, {
		fields: [teamAccessRequests.resolvedBy],
		references: [users.userId]
	}),
}));

export const partnerProfilesRelations = relations(partnerProfiles, ({one}) => ({
	user_referredByAgentId: one(users, {
		fields: [partnerProfiles.referredByAgentId],
		references: [users.userId],
		relationName: "partnerProfiles_referredByAgentId_users_userId"
	}),
	user_userId: one(users, {
		fields: [partnerProfiles.userId],
		references: [users.userId],
		relationName: "partnerProfiles_userId_users_userId"
	}),
}));

export const applicationEscalationsRelations = relations(applicationEscalations, ({one}) => ({
	application: one(applications, {
		fields: [applicationEscalations.applicationId],
		references: [applications.applicationId]
	}),
	user_escalatedBy: one(users, {
		fields: [applicationEscalations.escalatedBy],
		references: [users.userId],
		relationName: "applicationEscalations_escalatedBy_users_userId"
	}),
	user_relatedUserId: one(users, {
		fields: [applicationEscalations.relatedUserId],
		references: [users.userId],
		relationName: "applicationEscalations_relatedUserId_users_userId"
	}),
	user_resolvedBy: one(users, {
		fields: [applicationEscalations.resolvedBy],
		references: [users.userId],
		relationName: "applicationEscalations_resolvedBy_users_userId"
	}),
}));

export const applicationDocumentsRelations = relations(applicationDocuments, ({one, many}) => ({
	application: one(applications, {
		fields: [applicationDocuments.applicationId],
		references: [applications.applicationId]
	}),
	applicationDocument: one(applicationDocuments, {
		fields: [applicationDocuments.replacedBy],
		references: [applicationDocuments.documentId],
		relationName: "applicationDocuments_replacedBy_applicationDocuments_documentId"
	}),
	applicationDocuments: many(applicationDocuments, {
		relationName: "applicationDocuments_replacedBy_applicationDocuments_documentId"
	}),
	user: one(users, {
		fields: [applicationDocuments.uploadedBy],
		references: [users.userId]
	}),
	clientDocument: one(clientDocuments, {
		fields: [applicationDocuments.vaultDocumentId],
		references: [clientDocuments.documentId]
	}),
}));

export const clientSubscriptionsRelations = relations(clientSubscriptions, ({one, many}) => ({
	user_assignedBy: one(users, {
		fields: [clientSubscriptions.assignedBy],
		references: [users.userId],
		relationName: "clientSubscriptions_assignedBy_users_userId"
	}),
	user_clientId: one(users, {
		fields: [clientSubscriptions.clientId],
		references: [users.userId],
		relationName: "clientSubscriptions_clientId_users_userId"
	}),
	user_dedicatedAgentId: one(users, {
		fields: [clientSubscriptions.dedicatedAgentId],
		references: [users.userId],
		relationName: "clientSubscriptions_dedicatedAgentId_users_userId"
	}),
	subscriptionPlan: one(subscriptionPlans, {
		fields: [clientSubscriptions.planId],
		references: [subscriptionPlans.planId]
	}),
	dedicatedAgentFoci: many(dedicatedAgentFocus),
}));

export const subscriptionPlansRelations = relations(subscriptionPlans, ({many}) => ({
	clientSubscriptions: many(clientSubscriptions),
}));

export const messageReferencesRelations = relations(messageReferences, ({one}) => ({
	applicationMessage: one(applicationMessages, {
		fields: [messageReferences.messageId],
		references: [applicationMessages.messageId]
	}),
}));

export const messageEditsRelations = relations(messageEdits, ({one}) => ({
	user: one(users, {
		fields: [messageEdits.editedBy],
		references: [users.userId]
	}),
	applicationMessage: one(applicationMessages, {
		fields: [messageEdits.messageId],
		references: [applicationMessages.messageId]
	}),
}));

export const dedicatedAgentFocusRelations = relations(dedicatedAgentFocus, ({one}) => ({
	service: one(services, {
		fields: [dedicatedAgentFocus.serviceId],
		references: [services.serviceId]
	}),
	clientSubscription: one(clientSubscriptions, {
		fields: [dedicatedAgentFocus.subscriptionId],
		references: [clientSubscriptions.subscriptionId]
	}),
}));

export const clientObligationsRelations = relations(clientObligations, ({one}) => ({
	application: one(applications, {
		fields: [clientObligations.applicationId],
		references: [applications.applicationId]
	}),
	user_clientId: one(users, {
		fields: [clientObligations.clientId],
		references: [users.userId],
		relationName: "clientObligations_clientId_users_userId"
	}),
	user_resolvedBy: one(users, {
		fields: [clientObligations.resolvedBy],
		references: [users.userId],
		relationName: "clientObligations_resolvedBy_users_userId"
	}),
	serviceDeadlineRule: one(serviceDeadlineRules, {
		fields: [clientObligations.ruleId],
		references: [serviceDeadlineRules.id]
	}),
	service: one(services, {
		fields: [clientObligations.serviceId],
		references: [services.serviceId]
	}),
}));

export const applicationStatusHistoryRelations = relations(applicationStatusHistory, ({one}) => ({
	application: one(applications, {
		fields: [applicationStatusHistory.applicationId],
		references: [applications.applicationId]
	}),
	user: one(users, {
		fields: [applicationStatusHistory.changedBy],
		references: [users.userId]
	}),
}));

export const servicePriceBandsRelations = relations(servicePriceBands, ({one, many}) => ({
	applications: many(applications),
	service: one(services, {
		fields: [servicePriceBands.serviceId],
		references: [services.serviceId]
	}),
}));

export const serviceStructureVersionsRelations = relations(serviceStructureVersions, ({one, many}) => ({
	applications: many(applications),
	service: one(services, {
		fields: [serviceStructureVersions.serviceId],
		references: [services.serviceId]
	}),
}));

export const termsAcceptancesRelations = relations(termsAcceptances, ({one}) => ({
	user: one(users, {
		fields: [termsAcceptances.userId],
		references: [users.userId]
	}),
}));

export const messageAttachmentsRelations = relations(messageAttachments, ({one}) => ({
	application: one(applications, {
		fields: [messageAttachments.applicationId],
		references: [applications.applicationId]
	}),
	conversation: one(conversations, {
		fields: [messageAttachments.conversationId],
		references: [conversations.conversationId]
	}),
	applicationMessage: one(applicationMessages, {
		fields: [messageAttachments.messageId],
		references: [applicationMessages.messageId]
	}),
	user: one(users, {
		fields: [messageAttachments.uploadedBy],
		references: [users.userId]
	}),
}));

export const paymentSplitsRelations = relations(paymentSplits, ({one}) => ({
	payment: one(payments, {
		fields: [paymentSplits.paymentId],
		references: [payments.paymentId]
	}),
	user: one(users, {
		fields: [paymentSplits.workerId],
		references: [users.userId]
	}),
}));

export const paymentsRelations = relations(payments, ({many}) => ({
	paymentSplits: many(paymentSplits),
}));

export const refreshTokensRelations = relations(refreshTokens, ({one}) => ({
	user: one(users, {
		fields: [refreshTokens.userId],
		references: [users.userId]
	}),
}));

export const platformSettingsRelations = relations(platformSettings, ({one}) => ({
	user: one(users, {
		fields: [platformSettings.updatedBy],
		references: [users.userId]
	}),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({one}) => ({
	user: one(users, {
		fields: [passwordResetTokens.userId],
		references: [users.userId]
	}),
}));

export const agentSettingsRelations = relations(agentSettings, ({one}) => ({
	user: one(users, {
		fields: [agentSettings.userId],
		references: [users.userId]
	}),
}));

export const agentServiceSkillsRelations = relations(agentServiceSkills, ({one}) => ({
	user: one(users, {
		fields: [agentServiceSkills.agentId],
		references: [users.userId]
	}),
}));

export const backupCodesRelations = relations(backupCodes, ({one}) => ({
	user: one(users, {
		fields: [backupCodes.userId],
		references: [users.userId]
	}),
}));

export const servicePricingTiersRelations = relations(servicePricingTiers, ({one}) => ({
	service: one(services, {
		fields: [servicePricingTiers.serviceId],
		references: [services.serviceId]
	}),
}));

export const trustedDevicesRelations = relations(trustedDevices, ({one}) => ({
	user: one(users, {
		fields: [trustedDevices.userId],
		references: [users.userId]
	}),
}));

export const agentDocumentsRelations = relations(agentDocuments, ({one}) => ({
	user_agentId: one(users, {
		fields: [agentDocuments.agentId],
		references: [users.userId],
		relationName: "agentDocuments_agentId_users_userId"
	}),
	user_reviewedBy: one(users, {
		fields: [agentDocuments.reviewedBy],
		references: [users.userId],
		relationName: "agentDocuments_reviewedBy_users_userId"
	}),
}));

export const messageMentionsRelations = relations(messageMentions, ({one}) => ({
	applicationMessage: one(applicationMessages, {
		fields: [messageMentions.messageId],
		references: [applicationMessages.messageId]
	}),
	user: one(users, {
		fields: [messageMentions.userId],
		references: [users.userId]
	}),
}));

export const messageReactionsRelations = relations(messageReactions, ({one}) => ({
	applicationMessage: one(applicationMessages, {
		fields: [messageReactions.messageId],
		references: [applicationMessages.messageId]
	}),
	user: one(users, {
		fields: [messageReactions.userId],
		references: [users.userId]
	}),
}));

export const threadReadsRelations = relations(threadReads, ({one}) => ({
	application: one(applications, {
		fields: [threadReads.applicationId],
		references: [applications.applicationId]
	}),
	user: one(users, {
		fields: [threadReads.userId],
		references: [users.userId]
	}),
}));

export const conversationParticipantsRelations = relations(conversationParticipants, ({one}) => ({
	conversation: one(conversations, {
		fields: [conversationParticipants.conversationId],
		references: [conversations.conversationId]
	}),
	user: one(users, {
		fields: [conversationParticipants.userId],
		references: [users.userId]
	}),
}));