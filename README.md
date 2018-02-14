# Getting Started with Kubernetes Validating Admission Webhooks the FaaS Way

Kubernetes is a platform for running and managing application containers and has slowly evolved into a platform for building platforms, largely thanks to its extensible API. Kubernetes has many extension points including extensions that enable you to define [custom resource types](https://kubernetes.io/docs/concepts/api-extension/custom-resources), [cloud provider](https://kubernetes.io/docs/tasks/administer-cluster/running-cloud-controller) and [container runtime integrations](https://github.com/kubernetes/community/blob/master/contributors/devel/container-runtime-interface.md).

Another, less well known, set of extension points are the admission controllers. An admission controller is a piece of code that intercepts requests to the Kubernetes API prior to persistence of the object, but after the request is authenticated and authorized. Most admission controllers are built into Kubernetes and cover a range of functionality.

To understand how admission controllers work you need to see them in action. Take the [namespace exists admission controller](https://kubernetes.io/docs/admin/admission-controllers/#namespaceexists) for example, it rejects all requests that attempt to create resources in a namespace that does not exist.

If you were to list the active namespaces available to a new Kubernetes install you would see two or three namespaces including the `default` and `kube-system` namespaces. The `kube-system` namespace is where things like [Kubernetes DNS](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service) and the [Kubernetes Dashboard](https://kubernetes.io/docs/tasks/access-application-cluster/web-ui-dashboard/) live.

```
kubectl get ns
```

output:

```
NAME          STATUS    AGE
default       Active    3m
kube-public   Active    3m
kube-system   Active    3m
```

If you tried to create a deployment in a namespace that did not exist you would get an error because the `namespace exists` admission controller would reject it.

```
kubectl run nginx --image nginx --namespace does-not-exist
```

output:

```
Error from server (NotFound): namespaces "does-not-exist" not found
```

With a basic understanding of how admission controllers work it's time to take a look at the newest admission controller, the [validating admission webhook](https://kubernetes.io/docs/admin/admission-controllers/#validatingadmissionwebhook-alpha-in-18-beta-in-19). As it names implies, the validating admission webhook allows you to intercept and validate requests to the Kubernetes API using an external webhook, but not mutate them. That last point is critical; because validating admission webhooks can't mutate resources it's safe to run them in parallel, and quickly reject a request if any of the webhooks fail.

Before you can use them you'll need access to a Kubernetes cluster.

## Kubernetes the Easy Way

Before you can use validating admission webhooks you need access to a Kubernetes cluster.

There are many ways to provision a Kubernetes cluster, but I'm going to assume you want me to tell you exactly what to do so we can get back to building a validating admission webhook. This is where I point you to [Google Kubernetes Engine](https://cloud.google.com/kubernetes-engine) and swear it's not a vendor pitch. While I'm recommending GKE, everything should work on [minikube](https://kubernetes.io/docs/getting-started-guides/minikube) or [Docker support for Kubernetes](https://www.docker.com/kubernetes).

If you've chosen to follow along with GKE, run the following commands and wait for them to finish.

First create a 1.9.2+ Kubernetes cluster. We are going to spin a 1 node cluster to help save you some cash, and lighten the blow those bitcoin crashes are taking on your wallet.

Use the `gcloud` command to create the `k0` Kubernetes cluster:

```
gcloud container clusters create k0 \
  --cluster-version 1.9.2-gke.1 \
  --zone us-central1-a \
  --num-nodes 1
```

With the `k0` cluster in place it's time to design and build a validating admission webhook.

## How to Write a Validating Admission Webhook

We are going to write our first validating admission webhook using [nocode](https://github.com/kelseyhightower/nocode).

I'll give you a minute.

That's right, don't write a single line of code until you determine what rules you plan to use for accepting or rejecting a Kubernetes resource. For our first webhook we are going to keep things simple. We are going to reject all pods that leverage [environment variables](https://kubernetes.io/docs/tasks/inject-data-application/define-environment-variable-container) for application configuration.

You can write validating admission webhooks in just about any programming language, except nocode, and deploy it on any platform, including Kubernetes. But remember, the only goal is to validate incoming Kubernetes resources, not build a generic web application. In theory we only need to write a small bit of code to make that happen.

```javascript
function denyenv (req, res) {
  // Review the Kubernetes Pod resource and reject it if any
  // of the containers are using environment variables.
}
```

Given the minimual requirements for our validating admission webhook, we are going to skip containers altogether and deploy our webhook using a Function as a Service (FaaS) platform. Also know as Serverless.

### Serverless to the Rescue

We are going to implement our validating admission webhook using [Node.js](https://nodejs.org) and deploy it to [Google Cloud Functions](https://cloud.google.com/functions).

Now it's time to write the validating admission webhook. Create a directory named `denyenv` and move into it:

```
mkdir denyenv && cd denyenv
```

Next, save the following code block to a file named `index.js`:

```javascript
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
```

Run the following command to create a new function named `denyenv`:

```
gcloud beta functions deploy denyenv --trigger-http
```

Retrieve the HTTPS URL that triggers the `denyenv` function as we'll need it later when configuring our Kubernetes cluster to use it.

```
HTTPS_TRIGGER_URL=$(gcloud beta functions describe denyenv \
  --format 'value(httpsTrigger.url)')
```

## Validating Admission Webhook Configuration

With the `denyenv` function in place, it’s time to configure the Kubernetes cluster to use it.

Start by generating a validating webhook configuration and submitting it to the Kubernetes API:

```
cat <<EOF | kubectl apply -f -
apiVersion: admissionregistration.k8s.io/v1beta1
kind: ValidatingWebhookConfiguration
metadata:
  name: denyenv
webHooks:
  - name: denyenv.hightowerlabs.com
    rules:
      - apiGroups:
          - ""
        apiVersions:
          - v1
        operations:
          - CREATE
        resources:
          - pods
    failurePolicy: Fail
    clientConfig:
      url: "${HTTPS_TRIGGER_URL}"
EOF
```

output:

```
validatingwebhookconfiguration "denyenv" created
```

At this point we are all set to start testing the `denyenv` webhook.

## Testing

With the the `denyenv` validating admission webhook in place we need to ensure that it’s working.

First let’s make sure pods without env vars can be deployed to our Kubernetes clusters:

```
kubectl run nginx --image=nginx
```

output:

```
deployment "nginx" created
```

List the pods:

```
kubectl get pods
```
output:

```
NAME                   READY     STATUS    RESTARTS   AGE
nginx-8586cf59-qmdm4   1/1       Running   0          25s
```

It works. We can review the logs of the `denyenv` cloud function to show that it was indeed called:

```
gcloud beta functions logs read denyenv
```

output:

```
D      denyenv  wb9bmjb34uyh  2018-02-09 02:06:35.534  Function execution started
I      denyenv  wb9bmjb34uyh  2018-02-09 02:06:35.542  validating the nginx-8586cf59-qmdm4 pod
D      denyenv  wb9bmjb34uyh  2018-02-09 02:06:35.545  Function execution took 12 ms, finished with status code: 200
```

Next we need to ensure our webhook actually does the thing it’s designed to do, which is prevent pods with containers using env vars.

```
kubectl run nginx-with-env --image=nginx --env="PASSWORD=fail"
```

output:

```
deployment "nginx-with-env" created
```

List the pods:

```
kubectl get pods
```

output:

```
NAME                   READY     STATUS    RESTARTS   AGE
nginx-8586cf59-qmdm4   1/1       Running   0          1m
```

Its not there. What's going on?

The best way to determine why the `nginx-with-env` pod is not running is to review the Kubernetes event stream: 

```
kubectl get events
```

output:

```
Warning   FailedCreate  replicaset-controller Error creating: admission webhook "denyenv.hightowerlabs.com" denied the request: nginx-with-env is using env vars
```

Looks like the `nginx-with-env` pod was denied by the `denyenv` admission webhook. We can confirm by fetching the logs for the `denyenv` function.

```
gcloud beta functions logs read denyenv
```

```
I      denyenv  s1ij4wfykerr  2018-02-09 02:09:31.457  validating the nginx-with-env-76498b5b66-nw259 pod
I      denyenv  s1ij4wfykerr  2018-02-09 02:09:31.459  nginx-with-env is using env vars
D      denyenv  s1ij4wfykerr  2018-02-09 02:09:31.461  Function execution took 8 ms, finished with status code: 200
```

## Conclusion

Validating admission webhooks are one of easiest ways of extending Kubernetes with new policy controls. Building and running admission webhooks using a FaaS platform can help streamline the development process, and make it easy to enforce policy across multiple Kubernetes clusters using a single function.
