import type { Feedback } from "@/model/feedback";
import type { ManualRating } from "@/model/manual_rating";
import type { Experiment } from "@/components/view_mode/evaluation_mode/define_experiment";
import type { ModuleConfiguration } from "@/components/view_mode/evaluation_mode/configure_modules";

import { v4 as uuidv4 } from "uuid";
import { useEffect, useRef, useState } from "react";
import { useSendFeedbacks } from "./athena/send_feedbacks";
import useRequestSubmissionSelection from "./athena/request_submission_selection";
import useRequestFeedbackSuggestions from "./athena/request_feedback_suggestions";
import useSendSubmissions from "./athena/send_submissions";
import { useExperimentIdentifiersSetRunId } from "./experiment_identifiers_context";

export type ExperimentStep =
  | "notStarted"
  | "sendingSubmissions"
  | "sendingTrainingFeedbacks"
  | "generatingFeedbackSuggestions"
  | "finished";

export type BatchModuleExperimentState = {
  // Run ID
  runId: string;
  // The current step of the experiment
  step: ExperimentStep;
  // Submissions that have been sent to Athena
  didSendSubmissions: boolean;
  // Tutor feedbacks for training submissions that have been sent to Athena
  sentTrainingSubmissions: number[];
  // Feedback suggestions for evaluation submissions that have been generated by Athena
  // SubmissionId -> { suggestions: Feedback[]; meta: any;} where meta is the metadata of the request
  submissionsWithFeedbackSuggestions: Map<
    number,
    { suggestions: Feedback[]; meta: any }
  >;
};

export default function useBatchModuleExperiment(experiment: Experiment, moduleConfiguration: ModuleConfiguration) {
  // State of the module experiment
  const [data, setData] = useState<BatchModuleExperimentState>({
    runId: uuidv4(),
    step: "notStarted", // Not started
    didSendSubmissions: false,
    sentTrainingSubmissions: [],
    submissionsWithFeedbackSuggestions: new Map(),
  });

  // Stores annotations for manual evaluation
  const [submissionsWithManualRatings, setSubmissionsWithManualRatings] = useState<
    Map<number, ManualRating[]>
  >(new Map());

  const [processingStep, setProcessingStep] = useState<
    ExperimentStep | undefined
  >(undefined);
  const isMounted = useRef(true);
  const setContextRunId = useExperimentIdentifiersSetRunId();

  const startExperiment = () => {
    // Skip if the experiment has already started
    if (data.step !== "notStarted") {
      return;
    }

    setData((prevState) => ({
      ...prevState,
      step: "sendingSubmissions",
    }));
  };

  const exportData = () => {
    return { 
      results: {
        type: "results",
        runId: data.runId,
        experimentId: experiment.id,
        moduleConfigurationId: moduleConfiguration.id,
        step: data.step,
        didSendSubmissions: data.didSendSubmissions,
        sentTrainingSubmissions: data.sentTrainingSubmissions,
        submissionsWithFeedbackSuggestions: Object.fromEntries(
          data.submissionsWithFeedbackSuggestions
        ),
      },
      ...(
        submissionsWithManualRatings.size > 0 ? {
          manualRatings: {
            type: "manualRatings",
            runId: data.runId,
            experimentId: experiment.id,
            moduleConfigurationId: moduleConfiguration.id,
            submissionsWithManualRatings: Object.fromEntries(
              submissionsWithManualRatings
            ),
          },
        } : {}
      ),
    };
  };

  const importData = (importedData: any) => {
    if (importedData.type === "results") {
      if (importedData.runId === undefined ||
        importedData.step === undefined ||
        importedData.didSendSubmissions === undefined ||
        importedData.sentTrainingSubmissions === undefined ||
        importedData.submissionsWithFeedbackSuggestions === undefined) {
        return false;
      }

      setData(() => ({
        runId: importedData.runId,
        step: importedData.step,
        didSendSubmissions: importedData.didSendSubmissions,
        sentTrainingSubmissions: importedData.sentTrainingSubmissions,
        submissionsWithFeedbackSuggestions: new Map(
          Object.entries(importedData.submissionsWithFeedbackSuggestions).map(
            ([key, value]) => [Number(key), value as any]
          )
        ),
      }));

      return true;
    } else if (importedData.type === "manualRatings") {
      // Relies on the fact that the manual ratings have to be imported after the results
      if (importedData.submissionsWithManualRatings === undefined || importedData.runId !== data.runId) {
        return false;
      }
      setSubmissionsWithManualRatings(() => new Map(
        Object.entries(importedData.submissionsWithManualRatings).map(
          ([key, value]) => [Number(key), value as any]
        )
      ));

      return true;
    }

    // Unknown type
    return false;
  };

  const getManualRatingsSetter = (submissionId: number) => (manualRatings: ManualRating[]) => {
    setSubmissionsWithManualRatings((prevState) => {
      const newMap = new Map(prevState);
      newMap.set(submissionId, manualRatings);
      return newMap;
    });
  };

  const continueAfterTraining = (data.step === "sendingTrainingFeedbacks" && data.sentTrainingSubmissions.length === experiment.trainingSubmissions?.length) ? (() => {
    setData((prevState) => ({
      ...prevState,
      step: "generatingFeedbackSuggestions",
    }));
  }) : undefined;

  // Module requests
  const sendSubmissions = useSendSubmissions();
  const sendFeedbacks = useSendFeedbacks();
  const requestSubmissionSelection = useRequestSubmissionSelection();
  const requestFeedbackSuggestions = useRequestFeedbackSuggestions();

  // 1. Send submissions to Athena
  const stepSendSubmissions = () => {
    setProcessingStep("sendingSubmissions");
    console.log("Sending submissions to Athena...");
    sendSubmissions.mutate(
      {
        exercise: experiment.exercise,
        submissions: [
          ...(experiment.trainingSubmissions ?? []),
          ...experiment.evaluationSubmissions,
        ],
      },
      {
        onSuccess: () => {
          if (!isMounted.current) {
            return;
          }

          console.log("Sending submissions done!");
          setData((prevState) => ({
            ...prevState,
            step: "sendingTrainingFeedbacks", // next step
            didSendSubmissions: true,
          }));
        },
        onError: (error) => {
          console.error("Error while sending submissions to Athena:", error);
          // TODO: Recover?
        },
      }
    );
  };

  // 2. Send tutor feedbacks for training submissions to Athena
  const stepSendTrainingFeedbacks = async () => {
    setProcessingStep("sendingTrainingFeedbacks");
    // Skip if there are no training submissions
    if (!experiment.trainingSubmissions) {
      console.log("No training submissions, skipping");
      setData((prevState) => ({
        ...prevState,
        step: "generatingFeedbackSuggestions",
      }));
      return;
    }

    console.log("Sending training feedbacks to Athena...");

    const submissionsToSend = experiment.trainingSubmissions.filter(
      (submission) => !data.sentTrainingSubmissions.includes(submission.id)
    );

    let num = 0;
    for (const submission of submissionsToSend) {
      num += 1;
      const submissionFeedbacks = experiment.tutorFeedbacks.filter(
        (feedback) => feedback.submission_id === submission?.id
      );
      
      console.log(
        `Sending training feedbacks to Athena... (${num}/${submissionsToSend.length})`
      );

      try {  
        if (submissionFeedbacks.length > 0) {
          await sendFeedbacks.mutateAsync({
            exercise: experiment.exercise,
            submission,
            feedbacks: submissionFeedbacks,
          });
          if (!isMounted.current) {
            return;
          }
        }

        setData((prevState) => ({
          ...prevState,
          sentTrainingSubmissions: [
            ...prevState.sentTrainingSubmissions,
            submission.id,
          ],
        }));
      } catch (error) {
        console.error(
          `Sending training feedbacks for submission ${submission.id} failed with error:`,
          error
        );
      }
    }

    console.log("Sending training feedbacks done waiting to continue...");
  };

  // 3. Generate feedback suggestions
  const stepGenerateFeedbackSuggestions = async () => {
    setProcessingStep("generatingFeedbackSuggestions");
    console.log("Generating feedback suggestions...");

    let remainingSubmissions = experiment.evaluationSubmissions.filter(
      (submission) =>
        !data.submissionsWithFeedbackSuggestions.has(submission.id)
    );

    while (remainingSubmissions.length > 0) {
      const infoPrefix = `Generating feedback suggestions... (${
        experiment.evaluationSubmissions.length -
        remainingSubmissions.length +
        1
      }/${experiment.evaluationSubmissions.length})`;

      console.log(`${infoPrefix} - Requesting feedback suggestions...`);

      let submissionIndex = -1;
      try {
        const response = await requestSubmissionSelection.mutateAsync({
          exercise: experiment.exercise,
          submissions: remainingSubmissions,
        });
        if (!isMounted.current) {
          return;
        }

        console.log("Received submission selection:", response.data);

        if (response.data !== -1) {
          submissionIndex = remainingSubmissions.findIndex(
            (submission) => submission.id === response.data
          );
        }
      } catch (error) {
        console.error("Error while requesting submission selection:", error);
      }

      if (submissionIndex === -1) {
        // Select random submission
        submissionIndex = Math.floor(
          Math.random() * remainingSubmissions.length
        );
      }

      const submission = remainingSubmissions[submissionIndex];
      remainingSubmissions = [
        ...remainingSubmissions.slice(0, submissionIndex),
        ...remainingSubmissions.slice(submissionIndex + 1),
      ];

      console.log(
        `${infoPrefix} - Requesting feedback suggestions for submission ${submission.id}...`
      );

      try {
        const response = await requestFeedbackSuggestions.mutateAsync({
          exercise: experiment.exercise,
          submission,
        });
        if (!isMounted.current) {
          return;
        }

        console.log("Received feedback suggestions:", response.data);
        setData((prevState) => ({
          ...prevState,
          submissionsWithFeedbackSuggestions: new Map(
            prevState.submissionsWithFeedbackSuggestions.set(submission.id, {
              suggestions: response.data,
              meta: response.meta,
            })
          ),
        }));
      } catch (error) {
        console.error(
          `Error while generating feedback suggestions for submission ${submission.id}:`,
          error
        );
      }
    }

    setData((prevState) => ({
      ...prevState,
      step: "finished",
    }));
  };

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    setContextRunId(data.runId);
  }, [data.runId])

  useEffect(() => {
    if (experiment.executionMode !== "batch") {
      console.error("Using useBatchModuleExperiment in non-batch experiment!");
      return;
    }

    console.log("Step changed");
    if (
      data.step === "sendingSubmissions" &&
      processingStep !== "sendingSubmissions"
    ) {
      stepSendSubmissions();
    } else if (
      data.step === "sendingTrainingFeedbacks" &&
      processingStep !== "sendingTrainingFeedbacks"
    ) {
      stepSendTrainingFeedbacks();
    } else if (
      data.step === "generatingFeedbackSuggestions" &&
      processingStep !== "generatingFeedbackSuggestions"
    ) {
      stepGenerateFeedbackSuggestions();
    }
    // TODO: Add automatic evaluation step here
    // Note: Evaluate tutor feedback more globally to not do it multiple times
    // Note 2: Actually, I probably want to have it in parallel with the feedback suggestions for the interactive mode!
  }, [data.step]);

  return {
    data,
    getManualRatingsSetter,
    startExperiment,
    continueAfterTraining,
    exportData,
    importData,
    moduleRequests: {
      sendSubmissions,
      sendFeedbacks,
      requestSubmissionSelection,
      requestFeedbackSuggestions,
    },
  };
}
