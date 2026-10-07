export interface ClosedObjectSchema {
  readonly type: 'object'; readonly properties: Readonly<Record<string, unknown>>;
  readonly required: readonly string[]; readonly additionalProperties: false;
}
export const ownerApprovalInputSchema: ClosedObjectSchema;
export const ownerApprovalOutputSchema: ClosedObjectSchema;
