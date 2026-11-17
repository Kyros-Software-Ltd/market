
// ---------------------------------------------------------------------------------------------
// Market's additions to WebDriverAgent. controlapp/build.sh appends this file to
// WebDriverAgentLib/Commands/FBCustomCommands.m before building, so no Xcode project changes are
// needed: WDA finds every class that adopts FBCommandHandler and registers its routes.
//
//   GET  /market/photos/access   "authorized" | "limited" | "asking" | "denied"
//                                (asking: the phone is showing "Allow Market to add to Photos?")
//   POST /market/photos          { "name": "clip.mp4", "remove": true }
//                                Saves Documents/Market/<name> into Photos, dated now, and
//                                returns { "localIdentifier": ..., "video": true|false }.
//
// Market copies the file into Documents/Market over USB first (house_arrest), so together this
// puts a file from the PC into Photos with nothing happening on the screen.
// ---------------------------------------------------------------------------------------------
@import Photos;

@interface FBMarketCommands : NSObject <FBCommandHandler>
@end

@implementation FBMarketCommands

+ (NSArray *)routes
{
  return @[
    [[FBRoute GET:@"/market/photos/access"].withoutSession respondWithTarget:self action:@selector(handlePhotosAccess:)],
    [[FBRoute POST:@"/market/photos"].withoutSession respondWithTarget:self action:@selector(handleSaveToPhotos:)],
  ];
}

static NSString *FBMarketAccessName(PHAuthorizationStatus status)
{
  switch (status) {
    case PHAuthorizationStatusAuthorized: return @"authorized";
    case PHAuthorizationStatusLimited: return @"limited";
    case PHAuthorizationStatusNotDetermined: return @"asking";
    default: return @"denied";
  }
}

/** Current access; if never asked, asks now (the phone shows Apple's prompt) and says "asking". */
static PHAuthorizationStatus FBMarketCheckAccess(void)
{
  PHAuthorizationStatus status = [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelAddOnly];
  if (status == PHAuthorizationStatusNotDetermined) {
    [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelAddOnly handler:^(PHAuthorizationStatus s) {}];
  }
  return status;
}

+ (id<FBResponsePayload>)handlePhotosAccess:(FBRouteRequest *)request
{
  return FBResponseWithObject(FBMarketAccessName(FBMarketCheckAccess()));
}

+ (id<FBResponsePayload>)handleSaveToPhotos:(FBRouteRequest *)request
{
  NSString *name = request.arguments[@"name"];
  if (![name isKindOfClass:NSString.class] || name.length == 0 || [name containsString:@"/"] || [name hasPrefix:@"."]) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:@"name must be a file name in Documents/Market" traceback:nil]);
  }
  NSURL *documents = [NSFileManager.defaultManager URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask].firstObject;
  NSURL *file = [[documents URLByAppendingPathComponent:@"Market"] URLByAppendingPathComponent:name];
  if (![NSFileManager.defaultManager fileExistsAtPath:file.path]) {
    return FBResponseWithStatus([FBCommandStatus invalidArgumentErrorWithMessage:[NSString stringWithFormat:@"No %@ in Documents/Market", name] traceback:nil]);
  }

  PHAuthorizationStatus status = FBMarketCheckAccess();
  if (status != PHAuthorizationStatusAuthorized && status != PHAuthorizationStatusLimited) {
    return FBResponseWithStatus([FBCommandStatus unknownErrorWithMessage:[NSString stringWithFormat:@"PHOTOS_ACCESS_%@", FBMarketAccessName(status).uppercaseString] traceback:nil]);
  }

  NSString *ext = file.pathExtension.lowercaseString;
  BOOL video = [@[@"mp4", @"mov", @"m4v"] containsObject:ext];
  __block NSString *identifier = nil;
  __block BOOL ok = NO;
  __block NSError *error = nil;
  // Photos runs the change on its own queue and calls back off the main thread, so waiting
  // here is safe whichever thread WDA handles the request on.
  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [PHPhotoLibrary.sharedPhotoLibrary performChanges:^{
    PHAssetCreationRequest *create = [PHAssetCreationRequest creationRequestForAsset];
    PHAssetResourceCreationOptions *options = [PHAssetResourceCreationOptions new];
    options.originalFilename = name;
    [create addResourceWithType:(video ? PHAssetResourceTypeVideo : PHAssetResourceTypePhoto) fileURL:file options:options];
    // Newest in every picker, whatever date the file itself carries.
    create.creationDate = [NSDate date];
    identifier = create.placeholderForCreatedAsset.localIdentifier;
  } completionHandler:^(BOOL success, NSError *changeError) {
    ok = success;
    error = changeError;
    dispatch_semaphore_signal(done);
  }];
  if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(180 * NSEC_PER_SEC))) != 0) {
    return FBResponseWithStatus([FBCommandStatus unknownErrorWithMessage:@"Saving to Photos took longer than 3 minutes" traceback:nil]);
  }
  if (!ok) {
    return FBResponseWithStatus([FBCommandStatus unknownErrorWithMessage:[NSString stringWithFormat:@"Photos refused %@: %@", name, error.localizedDescription] traceback:nil]);
  }
  if ([request.arguments[@"remove"] boolValue]) {
    [NSFileManager.defaultManager removeItemAtURL:file error:nil];
  }
  return FBResponseWithObject(@{ @"localIdentifier": identifier ?: NSNull.null, @"video": @(video) });
}

@end
