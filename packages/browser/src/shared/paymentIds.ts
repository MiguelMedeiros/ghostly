/**
 * Payment ids are chosen by whoever sends them, and every member of a group sees the requests the others make to the
 * group. So a contact's request is kept under the id it came with, unless a record of another chat already holds that
 * id: then under `<id>.<chat>`. A `.` is never in a payment id on the wire (8 to 64 of `A-Z a-z 0-9 _ -`), so no
 * contact can name another's record, and two contacts' requests never share one.
 */
export const paymentAlias = (wireId: string, linkId: string): string => `${wireId}.${linkId}`;

/** The id a payment record goes by on the wire, which is also the one its chat and its group's notes know it by. */
export const paymentWireId = (key: string): string => key.split(".", 1)[0];
