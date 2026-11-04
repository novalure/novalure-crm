export const mailboxTriageStatuses=['needs_reply','waiting','done'] as const;
export type MailboxTriageStatus=typeof mailboxTriageStatuses[number];
export type MailboxTriageItem={id:string;subject:string;fromLabel:string;receivedAt:string;status:MailboxTriageStatus|'unreviewed';revision:number;leadId:string|null;projectName:string|null};
export type MailboxTriageState={items:MailboxTriageItem[];total:number;canReview:boolean};
