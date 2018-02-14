'use strict';

exports.denyenv = function denyenv (req, res) {
  var admissionRequest = req.body;

  // Get a reference to the pod spec
  var object = admissionRequest.request.object;

  console.log(`validating the ${object.metadata.name} pod`);

  var admissionResponse = {
    allowed: false
  };

  var found = false;
  for (var container of object.spec.containers) {
    if ("env" in container) {
      console.log(`${container.name} is using env vars`);

      admissionResponse.status = {
        status: 'Failure',
        message: `${container.name} is using env vars`,
        reason: `${container.name} is using env vars`,
        code: 402
      };

      found = true;
    };
  };

  if (!found) {
    admissionResponse.allowed = true;
  }

  var admissionReview = {
    response: admissionResponse
  };

  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(admissionReview));
  res.status(200).end();
};
