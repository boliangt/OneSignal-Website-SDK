import { MockExtendableEvent } from "../../MockExtendableEvent";

export class MockPushEvent extends MockExtendableEvent implements PushEvent {

  data: PushMessageData | null;

  private static EVENT_TYPE_PUSH_EVENT = "onpush";

  public constructor(data: PushMessageData) {
    super(MockPushEvent.EVENT_TYPE_PUSH_EVENT);
    this.data = data;
  }
    
  waitUntil(f: Promise<any>): void {
  }
}
